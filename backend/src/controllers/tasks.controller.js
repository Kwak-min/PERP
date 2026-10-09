import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import * as audit from "../services/audit.service.js";
import { notify } from "../services/notification.service.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(project.tasks) 전용 컨트롤러.
// project.tasks 에는 company_id 가 없어 JOIN project.projects p 로 회사 스코프를 건다.
// 프론트(TasksScreen/WorkloadScreen) 기대 필드로 매핑:
//   due_at <- due_on(YYYY-MM-DD), priority: 컬럼 없음 -> "normal",
//   ai_generated: 컬럼 없음 -> false, parent_id/recurrence: null, estimate_hours: 0

const createSchema = z.object({
  title: z.string().min(1).max(300),
  project_id: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  description: z.string().default(""),
  assignee_id: z.string().nullable().optional(),
  milestone_id: z.string().nullable().optional(),
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
  due_at: z.string().optional(),
  version: z.number().int().optional(),
});

const checklistSchema = z.object({
  // 프론트 호환: label 로 오면 title 로 받아들인다.
  title: z.string().min(1).max(300).optional(),
  label: z.string().min(1).max(300).optional(),
});

const dependencySchema = z.object({ depends_on_id: z.string() });

const commentSchema = z.object({
  body: z.string().min(1),
  mentions: z.array(z.string()).default([]),
});

// JOIN 쿼리용(별칭 t), 그리고 INSERT/UPDATE RETURNING용(별칭 없음) 두 벌.
const TASK_COLS = `
  t.id, t.project_id, t.milestone_id, t.assignee_id, t.title, t.description, t.status,
  to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.sort_order, t.version`;
const TASK_RET = `
  id, project_id, milestone_id, assignee_id, title, description, status,
  to_char(due_on, 'YYYY-MM-DD') AS due_on, sort_order, version`;

const view = (t) => ({
  id: t.id,
  project_id: t.project_id ?? null,
  parent_id: null,
  title: t.title,
  description: t.description ?? "",
  assignee_id: t.assignee_id ?? null,
  status: t.status,
  priority: "normal",
  due_at: t.due_on ?? null,
  recurrence: null,
  estimate_hours: 0,
  ai_generated: false,
  version: t.version,
});

async function recordAudit(entry) {
  try {
    audit.record(entry);
  } catch {
    // 감사 로그(현재 SQLite) 실패는 무시.
  }
}

async function safeNotify(entry) {
  try {
    notify(entry);
  } catch {
    // 알림(현재 SQLite) 실패는 무시.
  }
}

// 회사 스코프로 단일 task 조회(소속 프로젝트가 같은 회사인지 보장).
async function loadTask(orgId, taskId) {
  const { rows } = await pgQuery(
    `SELECT ${TASK_COLS}
     FROM project.tasks t
     JOIN project.projects p ON p.id = t.project_id
     WHERE t.id = $1 AND p.company_id::text = $2`,
    [taskId, orgId],
  );
  if (rows.length === 0) throw notFound("task");
  return rows[0];
}

export async function create(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = createSchema.parse(req.body);

  if (!payload.project_id) {
    throw new ApiError("VALIDATION_ERROR", "project_id is required");
  }

  // 프로젝트가 같은 회사 소속인지 확인
  const proj = await pgQuery(
    `SELECT id FROM project.projects WHERE id = $1 AND company_id::text = $2`,
    [payload.project_id, principal.orgId],
  );
  if (proj.rows.length === 0) throw notFound("project");

  const { rows } = await pgQuery(
    `INSERT INTO project.tasks
       (project_id, milestone_id, assignee_id, title, description, status, due_on, sort_order)
     VALUES ($1, $2, $3, $4, $5, 'todo', $6,
             COALESCE((SELECT MAX(sort_order) + 1 FROM project.tasks WHERE project_id = $1), 0))
     RETURNING ${TASK_RET}`,
    [
      payload.project_id,
      payload.milestone_id ?? null,
      payload.assignee_id ?? principal.userId,
      payload.title,
      payload.description,
      payload.due_at ?? null,
    ],
  );
  const task = rows[0];

  await recordAudit({
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

export async function list(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");

  const clauses = ["p.company_id::text = $1"];
  const params = [principal.orgId];
  if (req.query.project_id) {
    params.push(req.query.project_id);
    clauses.push(`t.project_id = $${params.length}`);
  }
  if (req.query.assignee_id) {
    params.push(req.query.assignee_id);
    clauses.push(`t.assignee_id = $${params.length}`);
  }
  if (req.query.status) {
    params.push(req.query.status);
    clauses.push(`t.status = $${params.length}`);
  }
  params.push(Number(req.query.limit ?? 50));
  const limitIdx = params.length;

  const { rows } = await pgQuery(
    `SELECT ${TASK_COLS}
     FROM project.tasks t
     JOIN project.projects p ON p.id = t.project_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.sort_order, t.id
     LIMIT $${limitIdx}`,
    params,
  );
  res.json({ items: rows.map(view), next_cursor: null });
}

export async function board(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");

  const clauses = ["p.company_id::text = $1"];
  const params = [principal.orgId];
  if (req.query.project_id) {
    params.push(req.query.project_id);
    clauses.push(`t.project_id = $${params.length}`);
  }

  const { rows } = await pgQuery(
    `SELECT ${TASK_COLS}
     FROM project.tasks t
     JOIN project.projects p ON p.id = t.project_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.sort_order, t.id
     LIMIT 500`,
    params,
  );

  const columns = { todo: [], in_progress: [], blocked: [], done: [] };
  for (const task of rows) {
    if (!columns[task.status]) columns[task.status] = [];
    columns[task.status].push(view(task));
  }
  res.json({
    columns: Object.entries(columns).map(([status, items]) => ({ status, items, wip_limit: 20 })),
  });
}

export async function detail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");
  const task = await loadTask(principal.orgId, req.params.taskId);

  const [checklist, dependencies, comments] = await Promise.all([
    pgQuery(
      `SELECT id, title, done FROM project.task_checklist_items
       WHERE task_id = $1 ORDER BY sort_order, id`,
      [task.id],
    ),
    pgQuery(
      `SELECT depends_on_id FROM project.task_dependencies WHERE task_id = $1`,
      [task.id],
    ),
    pgQuery(
      `SELECT id, author_id, body FROM project.task_comments
       WHERE task_id = $1 ORDER BY created_at, id`,
      [task.id],
    ),
  ]);

  res.json({
    ...view(task),
    checklist: checklist.rows.map((c) => ({
      id: c.id,
      label: c.title,
      title: c.title,
      required: false,
      done: Boolean(c.done),
    })),
    dependencies: dependencies.rows.map((d) => d.depends_on_id),
    comments: comments.rows.map((c) => ({ id: c.id, author_id: c.author_id, body: c.body })),
  });
}

// done 전환 가드: 미완(미완료) 선행 의존성이 있으면 409.
async function guardCompletion(orgId, task) {
  const { rows } = await pgQuery(
    `SELECT b.title, b.status
     FROM project.task_dependencies d
     JOIN project.tasks b ON b.id = d.depends_on_id
     WHERE d.task_id = $1 AND b.status <> 'done'`,
    [task.id],
  );
  if (rows.length > 0) {
    throw new ApiError("CONFLICT", `blocking dependency is not done: ${rows[0].title}`);
  }
}

export async function patch(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = patchSchema.parse(req.body);
  const task = await loadTask(principal.orgId, req.params.taskId);

  if (payload.version !== undefined && payload.version !== task.version) {
    throw new ApiError("VERSION_CONFLICT", "task was modified by someone else");
  }
  if (payload.status === "done") await guardCompletion(principal.orgId, task);

  const before = view(task);
  const sets = [];
  const params = [];
  // due_at -> due_on 컬럼 매핑
  const colMap = { title: "title", description: "description", assignee_id: "assignee_id", status: "status", due_at: "due_on" };
  for (const field of ["title", "description", "assignee_id", "status", "due_at"]) {
    if (payload[field] !== undefined) {
      params.push(payload[field]);
      sets.push(`${colMap[field]} = $${params.length}`);
    }
  }

  if (sets.length === 0) {
    res.json(view(task));
    return;
  }

  params.push(task.id);
  const idIdx = params.length;
  params.push(task.version);
  const verIdx = params.length;

  const { rows } = await pgQuery(
    `UPDATE project.tasks t
       SET ${sets.join(", ")}, version = version + 1, updated_at = now()
     WHERE t.id = $${idIdx} AND t.version = $${verIdx}
     RETURNING ${TASK_COLS}`,
    params,
  );
  if (rows.length === 0) {
    throw new ApiError("VERSION_CONFLICT", "task was modified by someone else");
  }
  const updated = rows[0];

  await recordAudit({
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

export async function addChecklist(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = checklistSchema.parse(req.body);
  const title = payload.title ?? payload.label;
  if (!title) throw new ApiError("VALIDATION_ERROR", "title is required");
  const task = await loadTask(principal.orgId, req.params.taskId);

  const { rows } = await pgQuery(
    `INSERT INTO project.task_checklist_items (task_id, title, done, sort_order)
     VALUES ($1, $2, false,
             COALESCE((SELECT MAX(sort_order) + 1 FROM project.task_checklist_items WHERE task_id = $1), 0))
     RETURNING id, title, done`,
    [task.id, title],
  );
  const item = rows[0];
  res.status(201).json({
    id: item.id,
    label: item.title,
    title: item.title,
    required: false,
    done: Boolean(item.done),
  });
}

export async function toggleChecklist(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  await loadTask(principal.orgId, req.params.taskId);

  const { rows } = await pgQuery(
    `UPDATE project.task_checklist_items
       SET done = NOT done
     WHERE id = $1 AND task_id = $2
     RETURNING id, done`,
    [req.params.itemId, req.params.taskId],
  );
  if (rows.length === 0) throw notFound("checklist item");
  res.json({ id: rows[0].id, done: Boolean(rows[0].done) });
}

export async function addDependency(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = dependencySchema.parse(req.body);
  const task = await loadTask(principal.orgId, req.params.taskId);
  const blocker = await loadTask(principal.orgId, payload.depends_on_id);
  if (blocker.id === task.id) {
    throw new ApiError("VALIDATION_ERROR", "a task cannot depend on itself");
  }
  await pgQuery(
    `INSERT INTO project.task_dependencies (task_id, depends_on_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [task.id, blocker.id],
  );
  res.status(201).json({ task_id: task.id, depends_on_id: blocker.id });
}

export async function addComment(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.write");
  const payload = commentSchema.parse(req.body);
  const task = await loadTask(principal.orgId, req.params.taskId);

  const { rows } = await pgQuery(
    `INSERT INTO project.task_comments (task_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, body`,
    [task.id, principal.userId, payload.body],
  );
  const comment = rows[0];

  for (const userId of payload.mentions) {
    await safeNotify({
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

export async function workload(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("task.read");

  // 담당자별 미완료(open) 업무 수. estimate_hours 컬럼이 없어 hours=0.
  const { rows } = await pgQuery(
    `SELECT COALESCE(t.assignee_id::text, 'unassigned') AS assignee_id,
            COUNT(*) FILTER (WHERE t.status NOT IN ('done', 'cancelled')) AS open
     FROM project.tasks t
     JOIN project.projects p ON p.id = t.project_id
     WHERE p.company_id::text = $1
     GROUP BY COALESCE(t.assignee_id::text, 'unassigned')`,
    [principal.orgId],
  );

  const items = rows.map((r) => {
    const open = Number(r.open);
    return { assignee_id: r.assignee_id, open, hours: 0, overload: open >= 3 };
  });
  res.json({ items });
}
