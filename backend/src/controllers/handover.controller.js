import { z } from "zod";

import { db } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import {
  bumpVersion,
  getScoped,
  insert,
  listScoped,
  nowIso,
  update,
} from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { ApiError } from "../utils/errors.js";

const packageSchema = z.object({
  predecessor_id: z.string(),
  successor_id: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  position: z.string().default(""),
  department_id: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  notes: z.string().default(""),
  ai_generated: z.boolean().default(false),
});

const itemSchema = z.object({
  category: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  detail: z.string().default(""),
  ref_type: z.string().nullable().optional(),
  ref_id: z.string().nullable().optional(),
  required: z.boolean().default(true),
});

const confirmationSchema = z.object({
  role: z.enum(["predecessor", "successor"]),
  comment: z.string().default(""),
});

function assertMember(principal, userId) {
  const row = db()
    .prepare(
      `SELECT id FROM membership
       WHERE tenant_id = ? AND org_id = ? AND user_id = ?
         AND status = 'active' AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, userId);
  if (!row) {
    throw new ApiError("VALIDATION_ERROR", "handover participant must be an active member", {
      user_id: userId,
    });
  }
}

function packageView(row) {
  return {
    id: row.id,
    predecessor_id: row.predecessor_id,
    successor_id: row.successor_id,
    title: row.title,
    position: row.position,
    department_id: row.department_id,
    status: row.status,
    due_at: row.due_at,
    completed_at: row.completed_at,
    notes: row.notes,
    ai_generated: Boolean(row.ai_generated),
    version: row.version,
  };
}

function itemView(row) {
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    detail: row.detail,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    required: Boolean(row.required),
    done: Boolean(row.done),
  };
}

function confirmationView(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    role: row.role,
    comment: row.comment,
    created_at: row.created_at,
  };
}

function children(principal, packageId) {
  return {
    items: listScoped(
      "handover_item",
      principal,
      [{ sql: "package_id = ?", params: [packageId] }],
      { limit: 500 },
    ),
    confirmations: listScoped(
      "handover_confirmation",
      principal,
      [{ sql: "package_id = ?", params: [packageId] }],
      { limit: 20 },
    ),
  };
}

function completeIfReady(principal, handover) {
  const related = children(principal, handover.id);
  const requiredPending = related.items.some((item) => item.required && !item.done);
  const confirmedRoles = new Set(related.confirmations.map((item) => item.role));
  const requiredRoles = handover.successor_id
    ? ["predecessor", "successor"]
    : ["predecessor"];
  if (!requiredPending && requiredRoles.every((role) => confirmedRoles.has(role))) {
    return bumpVersion(
      "handover_package",
      handover,
      { status: "completed", completed_at: nowIso() },
      principal.userId,
    );
  }
  return handover;
}

export function create(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("handover.confirm");
  const payload = packageSchema.parse(req.body);
  assertMember(principal, payload.predecessor_id);
  if (payload.successor_id) assertMember(principal, payload.successor_id);

  const row = insert("handover_package", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    predecessor_id: payload.predecessor_id,
    successor_id: payload.successor_id ?? null,
    title: payload.title,
    position: payload.position,
    department_id: payload.department_id ?? null,
    due_at: payload.due_at ?? null,
    notes: payload.notes,
    ai_generated: payload.ai_generated ? 1 : 0,
    created_by: principal.userId,
  });
  audit.record({
    tenantId: principal.tenantId,
    action: "handover.created",
    resourceType: "handover_package",
    resourceId: row.id,
    actorId: principal.userId,
    after: { title: row.title },
    requestId: req.requestId,
  });
  res.status(201).json(packageView(row));
}

export function list(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("handover.read");
  const filters = req.query.status
    ? [{ sql: "status = ?", params: [req.query.status] }]
    : [];
  const rows = listScoped("handover_package", principal, filters, {
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ items: rows.map(packageView), next_cursor: null });
}

export function detail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("handover.read");
  const row = getScoped(
    "handover_package",
    principal,
    req.params.packageId,
    "handover package",
  );
  const related = children(principal, row.id);
  res.json({
    ...packageView(row),
    items: related.items.map(itemView),
    confirmations: related.confirmations.map(confirmationView),
  });
}

export function addItem(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("handover.confirm");
  const handover = getScoped(
    "handover_package",
    principal,
    req.params.packageId,
    "handover package",
  );
  if (handover.status !== "draft") {
    throw new ApiError("CONFLICT", "items can only be added while handover is draft");
  }
  const payload = itemSchema.parse(req.body);
  const row = insert("handover_item", {
    tenant_id: principal.tenantId,
    package_id: handover.id,
    category: payload.category,
    label: payload.label,
    detail: payload.detail,
    ref_type: payload.ref_type ?? null,
    ref_id: payload.ref_id ?? null,
    required: payload.required ? 1 : 0,
    created_by: principal.userId,
  });
  res.status(201).json(itemView(row));
}

export function submit(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("handover.confirm");
  const handover = getScoped(
    "handover_package",
    principal,
    req.params.packageId,
    "handover package",
  );
  if (handover.status !== "draft") {
    throw new ApiError("CONFLICT", "only draft handovers can be submitted");
  }
  const related = children(principal, handover.id);
  if (related.items.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "handover requires at least one item");
  }
  const changed = bumpVersion(
    "handover_package",
    handover,
    { status: "active" },
    principal.userId,
  );
  res.json(packageView(changed));
}

export function completeItem(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("handover.confirm");
  const handover = getScoped(
    "handover_package",
    principal,
    req.params.packageId,
    "handover package",
  );
  if (handover.status !== "active") {
    throw new ApiError("CONFLICT", "handover must be active");
  }
  const item = getScoped("handover_item", principal, req.params.itemId, "handover item");
  if (item.package_id !== handover.id) {
    throw new ApiError("NOT_FOUND", "handover item not found");
  }
  const changed = update("handover_item", item.id, { done: 1 }, principal.userId);
  res.json(itemView(changed));
}

export function confirm(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("handover.confirm");
  const handover = getScoped(
    "handover_package",
    principal,
    req.params.packageId,
    "handover package",
  );
  if (handover.status !== "active") {
    throw new ApiError("CONFLICT", "handover must be active");
  }
  const payload = confirmationSchema.parse(req.body);
  const expectedUser =
    payload.role === "predecessor"
      ? handover.predecessor_id
      : handover.successor_id;
  if (!expectedUser || expectedUser !== principal.userId) {
    throw new ApiError("PERMISSION_DENIED", `only the ${payload.role} may confirm`);
  }
  const existing = children(principal, handover.id).confirmations.find(
    (item) => item.role === payload.role,
  );
  if (existing) throw new ApiError("CONFLICT", `${payload.role} already confirmed`);

  const confirmation = insert("handover_confirmation", {
    tenant_id: principal.tenantId,
    package_id: handover.id,
    user_id: principal.userId,
    role: payload.role,
    comment: payload.comment,
    created_by: principal.userId,
  });
  const changed = completeIfReady(principal, handover);
  audit.record({
    tenantId: principal.tenantId,
    action: "handover.confirmed",
    resourceType: "handover_package",
    resourceId: handover.id,
    actorId: principal.userId,
    after: { role: payload.role, status: changed.status },
    requestId: req.requestId,
  });
  res.json({ ...confirmationView(confirmation), package_status: changed.status });
}
