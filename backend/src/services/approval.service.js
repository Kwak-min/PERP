import { db } from "../config/db.js";
import { insert, listScoped, update } from "../models/base.js";
import * as audit from "./audit.service.js";
import { notify } from "./notification.service.js";
import { ApiError } from "../utils/errors.js";

export const HIGH_AMOUNT_MINOR = 1_000_000;

export function createApproval(principal, options) {
  const steps = options.steps ?? [];
  if (steps.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "approval requires at least one step");
  }

  const approval = insert("approval", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    form_key: options.formKey ?? "generic",
    title: options.title,
    requester_id: principal.userId,
    subject_type: options.subjectType ?? null,
    subject_id: options.subjectId ?? null,
    amount: options.amount ?? 0,
    due_at: options.dueAt ?? null,
    payload: JSON.stringify(options.payload ?? {}),
    created_by: principal.userId,
  });

  steps.forEach((step, ordinal) => {
    insert("approval_step", {
      tenant_id: principal.tenantId,
      approval_id: approval.id,
      ordinal,
      approver_id: step.approver_id,
      mode: step.mode ?? "sequential",
      kind: step.kind ?? "approve",
      created_by: principal.userId,
    });
    notify({
      tenantId: principal.tenantId,
      recipientId: step.approver_id,
      type: "approval.requested",
      title: `결재 요청: ${options.title}`,
      relatedType: "approval",
      relatedId: approval.id,
      dedupeKey: `approval:${approval.id}:${step.approver_id}`,
    });
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "approval.requested",
    resourceType: "approval",
    resourceId: approval.id,
    actorId: principal.userId,
    after: { title: options.title, amount: options.amount ?? 0 },
  });

  return approval;
}

export function stepsOf(principal, approvalId) {
  return listScoped(
    "approval_step",
    principal,
    [{ sql: "approval_id = ?", params: [approvalId] }],
    { limit: 100, orderBy: "ordinal ASC" },
  );
}

export function approvalView(principal, approval) {
  const steps = stepsOf(principal, approval.id);
  return {
    id: approval.id,
    title: approval.title,
    form_key: approval.form_key,
    requester_id: approval.requester_id,
    subject_type: approval.subject_type,
    subject_id: approval.subject_id,
    amount: approval.amount,
    status: approval.status,
    current_step: approval.current_step,
    requires_reauth: approval.amount >= HIGH_AMOUNT_MINOR,
    steps: steps.map((s) => ({
      ordinal: s.ordinal,
      approver_id: s.approver_id,
      mode: s.mode,
      kind: s.kind,
      status: s.status,
      comment: s.comment,
      decided_at: s.decided_at,
      delegate_of: s.delegate_of,
    })),
  };
}

export function advance(principal, approval) {
  const steps = stepsOf(principal, approval.id);
  if (steps.some((s) => s.status === "rejected")) {
    return update("approval", approval.id, { status: "rejected" }, principal.userId);
  }
  const pending = steps.filter((s) => s.status === "pending");
  if (pending.length === 0) {
    return update("approval", approval.id, { status: "approved" }, principal.userId);
  }
  return update(
    "approval",
    approval.id,
    { current_step: Math.min(...pending.map((s) => s.ordinal)) },
    principal.userId,
  );
}

export function approvalById(principal, approvalId) {
  return db()
    .prepare("SELECT * FROM approval WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(approvalId, principal.tenantId, principal.orgId) ?? null;
}
