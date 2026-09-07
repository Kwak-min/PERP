import { z } from "zod";

import { db } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { bumpVersion, getScoped, insert, listScoped, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { notify } from "../services/notification.service.js";
import { ApiError, notFound } from "../utils/errors.js";

const createSchema = z.object({
  title: z.string().min(1).max(300),
  project_id: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  description: z.string().default(""),
  assignee_id: z.string().nullable().optional(),
  priority: z.string().default("normal"),
  due_at: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  estimate_hours: z.number().int().default(0),
});

const patchSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  assignee_id: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  due_at: z.string().optional(),
  version: z.number().int().optional(),
});

const checklistSchema = z.object({
  label: z.string().min(1).max(300),
  required: z.boolean().default(false),
});

const dependencySchema = z.object({ depends_on_id: z.string() });

const commentSchema = z.object({
  body: z.string().min(1),
  mentions: z.array(z.string()).default([]),
});

const view = (t) => ({
  id: t.id,
  project_id: t.project_id,
  parent_id: t.parent_id,
  title: t.title,
  description: t.description,
  assignee_id: t.assignee_id,
  status: t.status,
  priority: t.priority,
  due_at: t.due_at,
  recurrence: t.recurrence,
  estimate_hours: t.estimate_hours,
  ai_generated: Boolean(t.ai_generated),
  version: t.version,
});

export function create(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = createSchema.parse(req.body);
  // 연결 대상도 현재 테넌트/조직 소속이어야 한다.
  if (payload.project_id) getScoped("project", principal, payload.project_id, "project");

  const task = insert("task", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    project_id: payload.project_id ?? null,
    parent_id: payload.parent_id ?? null,
    title: payload.title,
    description: payload.description,
    assignee_id: payload.assignee_id ?? principal.userId,
    priority: payload.priority,
    due_at: payload.due_at ?? null,
    recurrence: payload.recurrence ?? null,
    estimate_hours: payload.estimate_hours,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "task.created",
    resourceType: "task",
    resourceId: task.id,
    actorId: principal.userId,
    after: { title: task.title },
    requestId: req.requestId,
  });

  res.status(201).json(view(task));
}

export function list(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");
  const filters = [];
  if (req.query.project_id) filters.push({ sql: "project_id = ?", params: [req.query.project_id] });
  if (req.query.assignee_id) filters.push({ sql: "assignee_id = ?", params: [req.query.assignee_id] });
  if (req.query.status) filters.push({ sql: "status = ?", params: [req.query.status] });
  const rows = listScoped("task", principal, filters, { limit: Number(req.query.limit ?? (req.query.project_id ? -1 : 50)) });
  res.json({ items: rows.map(view), next_cursor: null });
}

export function board(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");
  const filters = req.query.project_id
    ? [{ sql: "project_id = ?", params: [req.query.project_id] }]
    : [];
  const rows = listScoped("task", principal, filters, { limit: 500 });
  const columns = { todo: [], in_progress: [], review: [], done: [] };
  for (const task of rows) {
    if (!columns[task.status]) columns[task.status] = [];
    columns[task.status].push(view(task));
  }
  res.json({
    columns: Object.entries(columns).map(([status, items]) => ({ status, items, wip_limit: 20 })),
  });
}

export function detail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");
  const task = getScoped("task", principal, req.params.taskId, "task");
  const checklist = listScoped(
    "task_checklist_item",
    principal,
    [{ sql: "task_id = ?", params: [task.id] }],
    { limit: 200, orderBy: "created_at ASC" },
  );
  const dependencies = listScoped(
    "task_dependency",
    principal,
    [{ sql: "task_id = ?", params: [task.id] }],
    { limit: 200 },
  );
  const comments = listScoped(
    "task_comment",
    principal,
    [{ sql: "task_id = ?", params: [task.id] }],
    { limit: 200, orderBy: "created_at ASC" },
  );
  res.json({
    ...view(task),
    checklist: checklist.map((c) => ({
      id: c.id,
      label: c.label,
      required: Boolean(c.required),
      done: Boolean(c.done),
    })),
    dependencies: dependencies.map((d) => d.depends_on_id),
    comments: comments.map((c) => ({ id: c.id, author_id: c.author_id, body: c.body })),
  });
}

function guardCompletion(principal, task) {
  const pending = listScoped(
    "task_checklist_item",
    principal,
    [
      { sql: "task_id = ?", params: [task.id] },
      { sql: "required = 1", params: [] },
      { sql: "done = 0", params: [] },
    ],
    { limit: 50 },
  );
  if (pending.length > 0) {
    throw new ApiError("CONFLICT", "required checklist items are not completed");
  }

  const dependencies = listScoped(
    "task_dependency",
    principal,
    [{ sql: "task_id = ?", params: [task.id] }],
    { limit: 200 },
  );
  for (const dependency of dependencies) {
    const blocker = db().prepare("SELECT * FROM task WHERE id = ?").get(dependency.depends_on_id);
    if (blocker && blocker.status !== "done") {
      throw new ApiError("CONFLICT", `blocking dependency is not done: ${blocker.title}`);
    }
  }
}

export function patch(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = patchSchema.parse(req.body);
  const task = getScoped("task", principal, req.params.taskId, "task");

  if (payload.version !== undefined && payload.version !== task.version) {
    throw new ApiError("VERSION_CONFLICT", "task was modified by someone else");
  }
  if (payload.status === "done") guardCompletion(principal, task);

  const before = view(task);
  const changes = {};
  for (const field of ["title", "description", "assignee_id", "status", "priority", "due_at"]) {
    if (payload[field] !== undefined) changes[field] = payload[field];
  }
  const updated = bumpVersion("task", task, changes, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "task.updated",
    resourceType: "task",
    resourceId: task.id,
    actorId: principal.userId,
    before,
    after: view(updated),
    requestId: req.requestId,
  });

  res.json(view(updated));
}

export function addChecklist(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = checklistSchema.parse(req.body);
  const task = getScoped("task", principal, req.params.taskId, "task");
  const item = insert("task_checklist_item", {
    tenant_id: principal.tenantId,
    task_id: task.id,
    label: payload.label,
    required: payload.required,
    created_by: principal.userId,
  });
  res.status(201).json({
    id: item.id,
    label: item.label,
    required: Boolean(item.required),
    done: Boolean(item.done),
  });
}

export function toggleChecklist(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  getScoped("task", principal, req.params.taskId, "task");
  const item = db()
    .prepare("SELECT * FROM task_checklist_item WHERE id = ? AND tenant_id = ? AND task_id = ?")
    .get(req.params.itemId, principal.tenantId, req.params.taskId);
  if (!item) throw notFound("checklist item");
  const updated = update("task_checklist_item", item.id, { done: item.done ? 0 : 1 }, principal.userId);
  res.json({ id: updated.id, done: Boolean(updated.done) });
}

export function addDependency(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = dependencySchema.parse(req.body);
  const task = getScoped("task", principal, req.params.taskId, "task");
  const blocker = getScoped("task", principal, payload.depends_on_id, "task");
  if (blocker.id === task.id) {
    throw new ApiError("VALIDATION_ERROR", "a task cannot depend on itself");
  }
  insert("task_dependency", {
    tenant_id: principal.tenantId,
    task_id: task.id,
    depends_on_id: blocker.id,
    created_by: principal.userId,
  });
  res.status(201).json({ task_id: task.id, depends_on_id: blocker.id });
}

export function addComment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = commentSchema.parse(req.body);
  const task = getScoped("task", principal, req.params.taskId, "task");
  const comment = insert("task_comment", {
    tenant_id: principal.tenantId,
    task_id: task.id,
    author_id: principal.userId,
    body: payload.body,
    mentions: payload.mentions.join(","),
    created_by: principal.userId,
  });

  for (const userId of payload.mentions) {
    notify({
      tenantId: principal.tenantId,
      recipientId: userId,
      type: "task.mention",
      title: "업무에서 언급되었습니다",
      body: payload.body.slice(0, 200),
      relatedType: "task",
      relatedId: task.id,
      dedupeKey: `mention:${comment.id}:${userId}`,
    });
  }

  res.status(201).json({ id: comment.id, body: comment.body });
}

export function workload(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");
  const rows = listScoped("task", principal, [], { limit: 1000 });
  const buckets = new Map();
  for (const task of rows) {
    const key = task.assignee_id ?? "unassigned";
    if (!buckets.has(key)) buckets.set(key, { assignee_id: key, open: 0, hours: 0, overload: false });
    if (task.status !== "done") {
      const bucket = buckets.get(key);
      bucket.open += 1;
      bucket.hours += task.estimate_hours;
    }
  }
  for (const bucket of buckets.values()) bucket.overload = bucket.hours > 40;
  res.json({ items: [...buckets.values()] });
}
