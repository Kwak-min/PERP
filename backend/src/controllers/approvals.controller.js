import { z } from "zod";

import { db } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, insert, listScoped, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import {
  HIGH_AMOUNT_MINOR,
  advance,
  approvalView,
  createApproval,
  stepsOf,
} from "../services/approval.service.js";
import { notify } from "../services/notification.service.js";
import { verifyPassword } from "../utils/crypto.js";
import { ApiError, notFound } from "../utils/errors.js";

const formSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  fields: z.array(z.record(z.any())).default([]),
  route: z.array(z.record(z.any())).default([]),
});

const requestSchema = z.object({
  title: z.string().min(1).max(300),
  form_key: z.string().default("generic"),
  steps: z
    .array(
      z.object({
        approver_id: z.string(),
        mode: z.string().default("sequential"),
        kind: z.string().default("approve"),
      }),
    )
    .default([]),
  subject_type: z.string().nullable().optional(),
  subject_id: z.string().nullable().optional(),
  amount: z.number().int().default(0),
  due_at: z.string().nullable().optional(),
  payload: z.record(z.any()).default({}),
});

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject", "hold"]),
  comment: z.string().default(""),
  reauth_password: z.string().nullable().optional(),
});

const delegateSchema = z.object({ to_user_id: z.string() });

export function createForm(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.form.manage");
  const payload = formSchema.parse(req.body);

  const existing = db()
    .prepare(
      `SELECT * FROM approval_form
       WHERE tenant_id = ? AND org_id = ? AND key = ? AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, payload.key);

  if (existing) {
    const updated = update(
      "approval_form",
      existing.id,
      {
        revision: existing.revision + 1,
        name: payload.name,
        fields_json: JSON.stringify(payload.fields),
        route_json: JSON.stringify(payload.route),
      },
      principal.userId,
    );
    res.json({ id: updated.id, key: updated.key, revision: updated.revision });
    return;
  }

  const form = insert("approval_form", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    key: payload.key,
    name: payload.name,
    fields_json: JSON.stringify(payload.fields),
    route_json: JSON.stringify(payload.route),
    created_by: principal.userId,
  });
  res.status(201).json({ id: form.id, key: form.key, revision: form.revision });
}

export function listForms(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const rows = listScoped("approval_form", principal, [], { limit: 200 });
  res.json({
    items: rows.map((f) => ({
      id: f.id,
      key: f.key,
      name: f.name,
      revision: f.revision,
      fields: JSON.parse(f.fields_json),
      route: JSON.parse(f.route_json),
    })),
  });
}

export function requestApproval(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const payload = requestSchema.parse(req.body);

  const approval = createApproval(principal, {
    title: payload.title,
    steps: payload.steps,
    formKey: payload.form_key,
    subjectType: payload.subject_type,
    subjectId: payload.subject_id,
    amount: payload.amount,
    dueAt: payload.due_at,
    payload: payload.payload,
  });

  res.status(201).json(approvalView(principal, approval));
}

export function listRequests(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const box = req.query.box ?? "inbox";
  const limit = Number(req.query.limit ?? 50);

  let rows;
  if (box === "sent") {
    rows = listScoped(
      "approval",
      principal,
      [{ sql: "requester_id = ?", params: [principal.userId] }],
      { limit },
    );
  } else {
    const steps = listScoped(
      "approval_step",
      principal,
      [
        { sql: "approver_id = ?", params: [principal.userId] },
        { sql: "status = ?", params: ["pending"] },
      ],
      { limit: 500 },
    );
    const ids = [...new Set(steps.map((s) => s.approval_id))];
    rows = ids
      .map((id) => db().prepare("SELECT * FROM approval WHERE id = ?").get(id))
      .filter((a) => a && a.status === "pending");
  }

  res.json({ items: rows.map((a) => approvalView(principal, a)), box });
}

export function getRequest(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const approval = getScoped("approval", principal, req.params.approvalId, "approval");
  res.json(approvalView(principal, approval));
}

export function decide(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.decide");
  const payload = decisionSchema.parse(req.body);
  const approval = getScoped("approval", principal, req.params.approvalId, "approval");

  if (approval.status !== "pending") {
    throw new ApiError("CONFLICT", `approval is already ${approval.status}`);
  }

  const steps = stepsOf(principal, approval.id);
  const mine = steps.filter((s) => s.approver_id === principal.userId && s.status === "pending");
  if (mine.length === 0) {
    throw new ApiError("PERMISSION_DENIED", "you are not a pending approver of this request");
  }
  const step = mine.reduce((a, b) => (a.ordinal <= b.ordinal ? a : b));

  if (step.mode === "sequential") {
    const earlier = steps.filter((s) => s.ordinal < step.ordinal && s.status === "pending");
    if (earlier.length > 0) {
      throw new ApiError("CONFLICT", "an earlier sequential step is still pending");
    }
  }

  if (approval.amount >= HIGH_AMOUNT_MINOR && payload.decision === "approve") {
    const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(principal.userId);
    if (!payload.reauth_password || !verifyPassword(payload.reauth_password, user.password_hash)) {
      throw new ApiError("PERMISSION_DENIED", "high-amount approval requires re-authentication");
    }
  }

  const statusByDecision = { approve: "approved", reject: "rejected", hold: "held" };
  update(
    "approval_step",
    step.id,
    {
      status: statusByDecision[payload.decision],
      comment: payload.comment,
      decided_at: new Date().toISOString(),
    },
    principal.userId,
  );

  let latest = db().prepare("SELECT * FROM approval WHERE id = ?").get(approval.id);
  if (payload.decision !== "hold") latest = advance(principal, latest);

  audit.record({
    tenantId: principal.tenantId,
    action: `approval.${payload.decision}`,
    resourceType: "approval",
    resourceId: approval.id,
    actorId: principal.userId,
    after: { status: latest.status, step: step.ordinal },
    approvalId: approval.id,
    requestId: req.requestId,
  });

  if (latest.status === "approved" || latest.status === "rejected") {
    notify({
      tenantId: principal.tenantId,
      recipientId: latest.requester_id,
      type: `approval.${latest.status}`,
      title: `결재 ${latest.status === "approved" ? "승인" : "반려"}: ${latest.title}`,
      relatedType: "approval",
      relatedId: latest.id,
      dedupeKey: `approval-result:${latest.id}`,
    });
  }

  res.json(approvalView(principal, latest));
}

export function withdraw(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const approval = getScoped("approval", principal, req.params.approvalId, "approval");
  if (approval.requester_id !== principal.userId) {
    throw new ApiError("PERMISSION_DENIED", "only the requester can withdraw");
  }
  if (approval.status !== "pending") {
    throw new ApiError("CONFLICT", `approval is already ${approval.status}`);
  }
  const updated = update("approval", approval.id, { status: "withdrawn" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "approval.withdrawn",
    resourceType: "approval",
    resourceId: approval.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.json(approvalView(principal, updated));
}

export function delegate(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.decide");
  const payload = delegateSchema.parse(req.body);
  const approval = getScoped("approval", principal, req.params.approvalId, "approval");

  const step = stepsOf(principal, approval.id).find(
    (s) => s.approver_id === principal.userId && s.status === "pending",
  );
  if (!step) throw notFound("pending approval step");

  update(
    "approval_step",
    step.id,
    { delegate_of: principal.userId, approver_id: payload.to_user_id },
    principal.userId,
  );

  audit.record({
    tenantId: principal.tenantId,
    action: "approval.delegated",
    resourceType: "approval",
    resourceId: approval.id,
    actorId: principal.userId,
    after: { to: payload.to_user_id },
    requestId: req.requestId,
  });

  res.json(approvalView(principal, approval));
}
