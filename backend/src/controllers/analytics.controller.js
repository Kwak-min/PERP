import { z } from "zod";

import { db } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, insert, listScoped, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { ApiError, notFound } from "../utils/errors.js";

const exportSchema = z.object({
  kind: z.enum(["transactions", "tasks", "members", "attendance", "assets", "audit"]),
  params: z.record(z.any()).default({}),
});

const EXPORT_SOURCES = {
  transactions: { table: "transaction_record", permission: "transaction.read" },
  tasks: { table: "task", permission: "task.read" },
  members: { table: "membership", permission: "member.read" },
  attendance: { table: "attendance", permission: "attendance.read" },
  assets: { table: "asset", permission: "asset.read" },
  audit: { table: "audit_event", permission: "audit.export" },
};

const scoped = (principal, sql, params = []) =>
  db()
    .prepare(sql)
    .all(principal.tenantId, principal.orgId, ...params);

function taskKpi(principal) {
  const rows = scoped(
    principal,
    `SELECT status, COUNT(*) AS c FROM task
     WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL GROUP BY status`,
  );
  const total = rows.reduce((sum, r) => sum + r.c, 0);
  const done = rows.find((r) => r.status === "done")?.c ?? 0;
  const overdue = scoped(
    principal,
    `SELECT COUNT(*) AS c FROM task
     WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL
       AND status != 'done' AND due_at IS NOT NULL AND due_at < ?`,
    [new Date().toISOString()],
  )[0].c;
  return {
    total,
    done,
    overdue,
    completion_rate: total === 0 ? 0 : Math.round((done / total) * 1000) / 10,
    by_status: Object.fromEntries(rows.map((r) => [r.status, r.c])),
  };
}

function financeKpi(principal) {
  const rows = scoped(
    principal,
    `SELECT kind, SUM(amount_minor) AS total FROM transaction_record
     WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL AND status = 'confirmed'
     GROUP BY kind`,
  );
  const income = rows.find((r) => r.kind === "income")?.total ?? 0;
  const expense = rows.find((r) => r.kind === "expense")?.total ?? 0;
  const budget = scoped(
    principal,
    `SELECT SUM(amount_minor) AS total FROM budget
     WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL`,
  )[0].total ?? 0;
  return {
    income_minor: income,
    expense_minor: expense,
    balance_minor: income - expense,
    budget_minor: budget,
    execution_rate: budget === 0 ? 0 : Math.round((expense / budget) * 1000) / 10,
  };
}

function memberKpi(principal) {
  const rows = scoped(
    principal,
    `SELECT status, COUNT(*) AS c FROM membership
     WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL GROUP BY status`,
  );
  return {
    total: rows.reduce((sum, r) => sum + r.c, 0),
    active: rows.find((r) => r.status === "active")?.c ?? 0,
    by_status: Object.fromEntries(rows.map((r) => [r.status, r.c])),
  };
}

function approvalKpi(principal) {
  const rows = scoped(
    principal,
    `SELECT status, COUNT(*) AS c FROM approval
     WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL GROUP BY status`,
  );
  return {
    total: rows.reduce((sum, r) => sum + r.c, 0),
    pending: rows.find((r) => r.status === "pending")?.c ?? 0,
    by_status: Object.fromEntries(rows.map((r) => [r.status, r.c])),
  };
}

function agentKpi(principal) {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(cost_micro) AS cost, AVG(latency_ms) AS latency
       FROM ai_request_log WHERE tenant_id = ?`,
    )
    .get(principal.tenantId);
  return {
    calls: row.calls ?? 0,
    cost_micro: row.cost ?? 0,
    avg_latency_ms: Math.round(row.latency ?? 0),
  };
}

export function kpis(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("analytics.read");
  res.json({
    tasks: taskKpi(principal),
    finance: financeKpi(principal),
    members: memberKpi(principal),
    approvals: approvalKpi(principal),
    agent: agentKpi(principal),
    generated_at: new Date().toISOString(),
  });
}

export function dashboard(req, res) {
  const principal = resolvePrincipal(req);
  const myTasks = db()
    .prepare(
      `SELECT id, title, status, priority, due_at FROM task
       WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL
         AND assignee_id = ? AND status != 'done'
       ORDER BY due_at IS NULL, due_at LIMIT 10`,
    )
    .all(principal.tenantId, principal.orgId, principal.userId);

  const myApprovals = db()
    .prepare(
      `SELECT a.id, a.title, a.status FROM approval a
       JOIN approval_step s ON s.approval_id = a.id
       WHERE a.tenant_id = ? AND a.org_id = ? AND a.deleted_at IS NULL
         AND s.approver_id = ? AND s.status = 'pending'
       ORDER BY a.created_at DESC LIMIT 10`,
    )
    .all(principal.tenantId, principal.orgId, principal.userId);

  const upcoming = db()
    .prepare(
      `SELECT id, title, start_at, end_at, location FROM event
       WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL AND end_at >= ?
       ORDER BY start_at LIMIT 10`,
    )
    .all(principal.tenantId, principal.orgId, new Date().toISOString());

  const unread = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM notification
       WHERE tenant_id = ? AND recipient_id = ? AND read_at IS NULL AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.userId).c;

  res.json({
    my_tasks: myTasks,
    my_approvals: myApprovals,
    upcoming_events: upcoming,
    unread_notifications: unread,
    modules: (req.organization?.modules ?? "").split(",").filter(Boolean),
  });
}

export function report(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("analytics.read");
  const kind = req.query.kind ?? "monthly";
  const period = req.query.period ?? new Date().toISOString().slice(0, 7);

  if (kind === "monthly") {
    const rows = db()
      .prepare(
        `SELECT kind, SUM(amount_minor) AS total, COUNT(*) AS c FROM transaction_record
         WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL
           AND status = 'confirmed' AND substr(occurred_on, 1, 7) = ?
         GROUP BY kind`,
      )
      .all(principal.tenantId, principal.orgId, period);
    const tasks = db()
      .prepare(
        `SELECT COUNT(*) AS c FROM task
         WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL
           AND substr(created_at, 1, 7) = ?`,
      )
      .get(principal.tenantId, principal.orgId, period).c;
    res.json({
      kind,
      period,
      finance: Object.fromEntries(rows.map((r) => [r.kind, { total_minor: r.total, count: r.c }])),
      tasks_created: tasks,
    });
    return;
  }

  if (kind === "workload") {
    const rows = db()
      .prepare(
        `SELECT assignee_id, COUNT(*) AS open_tasks, SUM(estimate_hours) AS hours FROM task
         WHERE tenant_id = ? AND org_id = ? AND deleted_at IS NULL AND status != 'done'
         GROUP BY assignee_id ORDER BY open_tasks DESC`,
      )
      .all(principal.tenantId, principal.orgId);
    res.json({ kind, items: rows });
    return;
  }

  throw new ApiError("VALIDATION_ERROR", `알 수 없는 보고서 종류: ${kind}`, {
    available: ["monthly", "workload"],
  });
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(",")),
  ].join("\n");
}

export function createExport(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("analytics.read");
  const payload = exportSchema.parse(req.body);
  const source = EXPORT_SOURCES[payload.kind];
  principal.require(source.permission);

  const job = insert("export_job", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    kind: payload.kind,
    params: JSON.stringify(payload.params),
    status: "running",
    requested_by: principal.userId,
    expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    created_by: principal.userId,
  });

  const rows =
    payload.kind === "audit"
      ? db()
          .prepare("SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY seq DESC LIMIT 5000")
          .all(principal.tenantId)
      : listScoped(source.table, principal, [], { limit: 5000 });

  const done = update(
    "export_job",
    job.id,
    { status: "ready", file_path: `exports/${job.id}.csv` },
    principal.userId,
  );

  audit.record({
    tenantId: principal.tenantId,
    action: "export.created",
    resourceType: "export_job",
    resourceId: job.id,
    actorId: principal.userId,
    after: { kind: payload.kind, rows: rows.length },
    requestId: req.requestId,
  });

  res.status(201).json({
    id: done.id,
    kind: done.kind,
    status: done.status,
    row_count: rows.length,
    file_path: done.file_path,
    expires_at: done.expires_at,
  });
}

export function listExports(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("analytics.read");
  const rows = listScoped("export_job", principal, [], { limit: Number(req.query.limit ?? 100) });
  res.json({
    items: rows.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      requested_by: j.requested_by,
      file_path: j.file_path,
      expires_at: j.expires_at,
      created_at: j.created_at,
    })),
  });
}

export function downloadExport(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("analytics.read");
  const job = getScoped("export_job", principal, req.params.exportId, "export job");
  if (job.status !== "ready") throw new ApiError("CONFLICT", `export is ${job.status}`);
  if (job.expires_at && job.expires_at < new Date().toISOString()) {
    throw new ApiError("CONFLICT", "export link has expired");
  }

  const source = EXPORT_SOURCES[job.kind];
  if (!source) throw notFound("export kind");
  principal.require(source.permission);

  const rows =
    job.kind === "audit"
      ? db()
          .prepare("SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY seq DESC LIMIT 5000")
          .all(principal.tenantId)
      : listScoped(source.table, principal, [], { limit: 5000 });

  audit.record({
    tenantId: principal.tenantId,
    action: "export.downloaded",
    resourceType: "export_job",
    resourceId: job.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${job.kind}-${job.id}.csv"`);
  res.send(rowsToCsv(rows));
}
