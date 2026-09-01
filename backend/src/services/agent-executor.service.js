import { db } from "../config/db.js";
import { getScoped, insert, nowIso, softDelete, update } from "../models/base.js";
import * as audit from "./audit.service.js";
import { createApproval } from "./approval.service.js";
import { ApiError, notFound } from "../utils/errors.js";

const TX = "transaction_record";

function membershipOf(principal, membershipId) {
  const row = db()
    .prepare("SELECT * FROM membership WHERE id = ? AND tenant_id = ? AND org_id = ?")
    .get(membershipId, principal.tenantId, principal.orgId);
  if (!row) throw notFound("membership");
  return row;
}

export function buildPreview(principal, tool, payload) {
  switch (tool) {
    case "create.task":
      return { action: "create task", after: { title: payload.title, assignee_id: payload.assignee_id } };
    case "update.task_status": {
      const task = getScoped("task", principal, payload.task_id, "task");
      return { action: "update task status", before: { status: task.status }, after: { status: payload.status } };
    }
    case "create.event":
      return { action: "create event", after: { title: payload.title } };
    case "create.document":
      return { action: "create document", after: { title: payload.title } };
    case "confirm.transaction": {
      const tx = getScoped(TX, principal, payload.transaction_id, "transaction");
      return {
        action: "confirm transaction",
        before: { status: tx.status, amount_minor: tx.amount_minor },
        after: { status: "confirmed", amount_minor: tx.amount_minor },
        impact: "회계 원장과 예산 집행률이 변경됩니다",
      };
    }
    case "update.budget": {
      const budget = getScoped("budget", principal, payload.budget_id, "budget");
      return {
        action: "update budget",
        before: { amount_minor: budget.amount_minor, revision: budget.revision },
        after: { amount_minor: payload.amount_minor, revision: budget.revision + 1 },
      };
    }
    case "change.member_status": {
      const membership = membershipOf(principal, payload.membership_id);
      return {
        action: "change member status",
        before: { status: membership.status },
        after: { status: payload.status },
        impact: "세션과 접근 권한이 즉시 영향을 받습니다",
      };
    }
    case "change.permission": {
      const membership = membershipOf(principal, payload.membership_id);
      return {
        action: "change member roles",
        before: { roles: (membership.roles ?? "").split(",").filter(Boolean) },
        after: { roles: payload.roles },
        impact: "권한 범위가 변경됩니다",
      };
    }
    case "delete.task": {
      const task = getScoped("task", principal, payload.task_id, "task");
      return { action: "delete task", before: { title: task.title, deleted_at: null }, after: { deleted_at: "now" } };
    }
    case "delete.document": {
      const document = getScoped("document", principal, payload.document_id, "document");
      return { action: "delete document", before: { title: document.title }, after: { deleted_at: "now" } };
    }
    case "send.notification":
      return { action: "send notification", after: { recipient_id: payload.recipient_id, title: payload.title } };
    case "submit.approval":
      return { action: "submit approval", after: { title: payload.title } };
    default:
      return { action: tool, after: payload };
  }
}

export function execute(principal, action) {
  const payload = JSON.parse(action.input_json || "{}");

  switch (action.tool) {
    case "create.task": {
      const task = insert("task", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        title: payload.title,
        assignee_id: payload.assignee_id ?? principal.userId,
        due_at: payload.due_at ?? null,
        project_id: payload.project_id ?? null,
        ai_generated: 1,
        created_by: principal.userId,
      });
      return [{ task_id: task.id }, { kind: "soft_delete", resource: "task", id: task.id }];
    }
    case "update.task_status": {
      const task = getScoped("task", principal, payload.task_id, "task");
      const before = task.status;
      const updated = update("task", task.id, { status: payload.status, version: task.version + 1 }, principal.userId);
      return [
        { task_id: updated.id, status: updated.status },
        { kind: "restore_field", resource: "task", id: task.id, field: "status", value: before },
      ];
    }
    case "create.event": {
      const event = insert("event", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        title: payload.title,
        start_at: payload.start_at,
        end_at: payload.end_at,
        created_by: principal.userId,
      });
      return [{ event_id: event.id }, { kind: "soft_delete", resource: "event", id: event.id }];
    }
    case "create.document": {
      const document = insert("document", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        title: payload.title,
        content: payload.content ?? "",
        ai_generated: 1,
        review_status: "pending",
        created_by: principal.userId,
      });
      return [{ document_id: document.id }, { kind: "soft_delete", resource: "document", id: document.id }];
    }
    case "confirm.transaction": {
      const tx = getScoped(TX, principal, payload.transaction_id, "transaction");
      if (tx.status === "confirmed") throw new ApiError("CONFLICT", "transaction already confirmed");
      const updated = update(TX, tx.id, { status: "confirmed", version: tx.version + 1 }, principal.userId);
      return [
        { transaction_id: updated.id, status: updated.status },
        { kind: "restore_field", resource: "transaction_record", id: tx.id, field: "status", value: "draft" },
      ];
    }
    case "update.budget": {
      const budget = getScoped("budget", principal, payload.budget_id, "budget");
      const before = budget.amount_minor;
      const updated = update(
        "budget",
        budget.id,
        { amount_minor: payload.amount_minor, revision: budget.revision + 1 },
        principal.userId,
      );
      return [
        { budget_id: updated.id, amount_minor: updated.amount_minor },
        { kind: "restore_field", resource: "budget", id: budget.id, field: "amount_minor", value: before },
      ];
    }
    case "change.member_status": {
      const membership = membershipOf(principal, payload.membership_id);
      const before = membership.status;
      const updated = update(
        "membership",
        membership.id,
        { status: payload.status, version: membership.version + 1 },
        principal.userId,
      );
      return [
        { membership_id: updated.id, status: updated.status },
        { kind: "restore_field", resource: "membership", id: membership.id, field: "status", value: before },
      ];
    }
    case "change.permission": {
      const membership = membershipOf(principal, payload.membership_id);
      const before = membership.roles;
      const updated = update(
        "membership",
        membership.id,
        { roles: payload.roles.join(","), version: membership.version + 1 },
        principal.userId,
      );
      return [
        { membership_id: updated.id, roles: (updated.roles ?? "").split(",").filter(Boolean) },
        { kind: "restore_field", resource: "membership", id: membership.id, field: "roles", value: before },
      ];
    }
    case "delete.task": {
      const task = getScoped("task", principal, payload.task_id, "task");
      softDelete("task", task.id, principal.userId);
      return [
        { task_id: task.id, deleted: true },
        { kind: "restore_field", resource: "task", id: task.id, field: "deleted_at", value: null },
      ];
    }
    case "delete.document": {
      const document = getScoped("document", principal, payload.document_id, "document");
      softDelete("document", document.id, principal.userId);
      return [
        { document_id: document.id, deleted: true },
        { kind: "restore_field", resource: "document", id: document.id, field: "deleted_at", value: null },
      ];
    }
    case "send.notification": {
      const notification = insert("notification", {
        tenant_id: principal.tenantId,
        recipient_id: payload.recipient_id,
        type: "agent.message",
        title: payload.title,
        body: payload.body ?? "",
      });
      return [
        { notification_id: notification.id },
        { kind: "soft_delete", resource: "notification", id: notification.id },
      ];
    }
    case "submit.approval": {
      const approval = createApproval(principal, {
        title: payload.title,
        steps: [{ approver_id: payload.approver_id }],
        formKey: payload.form_key ?? "generic",
        amount: payload.amount ?? 0,
      });
      return [{ approval_id: approval.id }, { kind: "withdraw_approval", resource: "approval", id: approval.id }];
    }
    default:
      throw new ApiError("VALIDATION_ERROR", `tool is not executable: ${action.tool}`);
  }
}

const ROLLBACK_TABLES = new Set([
  "task",
  "document",
  "event",
  "transaction_record",
  "budget",
  "membership",
  "notification",
  "approval",
]);

export function rollback(principal, action) {
  if (!action.rollback_ref) {
    throw new ApiError("CONFLICT", "no rollback information stored for this action");
  }
  const ref = JSON.parse(action.rollback_ref);
  if (!ROLLBACK_TABLES.has(ref.resource)) {
    throw new ApiError("CONFLICT", `rollback is not supported for ${ref.resource}`);
  }

  const row = db().prepare(`SELECT * FROM ${ref.resource} WHERE id = ?`).get(ref.id);
  if (!row) throw notFound(ref.resource);
  if (row.tenant_id !== principal.tenantId) throw notFound(ref.resource);

  if (ref.kind === "soft_delete") {
    update(ref.resource, ref.id, { deleted_at: nowIso() }, principal.userId);
  } else if (ref.kind === "restore_field") {
    update(ref.resource, ref.id, { [ref.field]: ref.value }, principal.userId);
  } else if (ref.kind === "withdraw_approval") {
    update("approval", ref.id, { status: "withdrawn" }, principal.userId);
  }

  update("agent_action", action.id, { status: "rolled_back" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "agent.action.rolled_back",
    resourceType: "agent_action",
    resourceId: action.id,
    actorId: principal.userId,
    after: { tool: action.tool, rollback: ref },
    aiGenerated: true,
  });

  return { action_id: action.id, status: "rolled_back", rollback: ref };
}
