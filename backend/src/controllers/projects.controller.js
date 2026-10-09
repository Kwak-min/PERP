import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import * as audit from "../services/audit.service.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(project.projects) 전용 컨트롤러.
// 프론트(ProjectsScreen 등)가 기대하는 응답 필드로 매핑해 돌려준다.
//   owner_id   <- lead_id
//   start_date <- starts_on, end_date <- ends_on (YYYY-MM-DD 문자열)
//   budget_amount: perp_db 에 컬럼이 없어 항상 0, visibility: 상수 "org"
// 모든 조회/쓰기는 company_id = principal.orgId 로 스코프.

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().default(""),
  department_id: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  // 프론트 호환용으로 받되 perp_db 스키마엔 없어 저장하지 않음
  budget_amount: z.number().int().default(0),
  visibility: z.string().default("org"),
});

const patchSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  version: z.number().int().optional(),
});

const milestoneSchema = z.object({
  name: z.string().min(1).max(200),
  due_at: z.string().nullable().optional(),
});

const memberSchema = z.object({
  user_id: z.string(),
  role: z.string().default("member"),
});

// SELECT 시 날짜는 to_char 로 YYYY-MM-DD 문자열 고정(타임존 오프셋 방지).
const PROJECT_COLS = `
  id, company_id, department_id, team_id, name, description, status,
  to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
  lead_id, version`;

// perp_db row -> 프론트 기대 형태
const view = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description ?? "",
  status: p.status,
  owner_id: p.lead_id ?? null,
  department_id: p.department_id ?? null,
  visibility: "org",
  start_date: p.starts_on ?? null,
  end_date: p.ends_on ?? null,
  budget_amount: 0,
  version: p.version,
});

async function recordAudit(entry) {
  try {
    audit.record(entry);
  } catch {
    // 감사 로그 저장(현재 SQLite)이 실패해도 요청은 계속 성공시킨다.
  }
}

async function loadProject(orgId, projectId) {
  const { rows } = await pgQuery(
    `SELECT ${PROJECT_COLS} FROM project.projects WHERE id = $1 AND company_id::text = $2`,
    [projectId, orgId],
  );
  if (rows.length === 0) throw notFound("project");
  return rows[0];
}

export async function create(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const payload = createSchema.parse(req.body);

  const project = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO project.projects
         (company_id, department_id, name, description, status, starts_on, ends_on, lead_id)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
       RETURNING ${PROJECT_COLS}`,
      [
        principal.orgId,
        payload.department_id ?? null,
        payload.name,
        payload.description,
        payload.start_date ?? null,
        payload.end_date ?? null,
        principal.userId,
      ],
    );
    const created = rows[0];
    await client.query(
      `INSERT INTO project.project_members (project_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', now())
       ON CONFLICT DO NOTHING`,
      [created.id, principal.userId],
    );
    return created;
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: "project.created",
    resourceType: "project",
    resourceId: project.id,
    actorId: principal.userId,
    after: { name: project.name },
    requestId: req.requestId,
  });

  res.status(201).json(view(project));
}

export async function list(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.read");

  const clauses = ["company_id::text = $1"];
  const params = [principal.orgId];
  if (req.query.status) {
    params.push(req.query.status);
    clauses.push(`status = $${params.length}`);
  }
  if (req.query.department_id) {
    params.push(req.query.department_id);
    clauses.push(`department_id::text = $${params.length}`);
  }
  params.push(Number(req.query.limit ?? 50));
  const limitIdx = params.length;

  const { rows } = await pgQuery(
    `SELECT ${PROJECT_COLS} FROM project.projects
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`,
    params,
  );
  res.json({ items: rows.map(view), next_cursor: null });
}

export async function detail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.read");
  const project = await loadProject(principal.orgId, req.params.projectId);

  const [members, milestones] = await Promise.all([
    pgQuery(
      `SELECT user_id, role FROM project.project_members WHERE project_id = $1 ORDER BY joined_at`,
      [project.id],
    ),
    pgQuery(
      `SELECT id, name, to_char(due_on, 'YYYY-MM-DD') AS due_on, status
       FROM project.milestones WHERE project_id = $1 ORDER BY sort_order`,
      [project.id],
    ),
  ]);

  res.json({
    ...view(project),
    members: members.rows.map((m) => ({ user_id: m.user_id, role: m.role })),
    milestones: milestones.rows.map((m) => ({
      id: m.id,
      name: m.name,
      due_at: m.due_on ?? null,
      status: m.status,
    })),
  });
}

export async function patch(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const payload = patchSchema.parse(req.body);
  const project = await loadProject(principal.orgId, req.params.projectId);

  if (payload.version !== undefined && payload.version !== project.version) {
    throw new ApiError("VERSION_CONFLICT", "project was modified by someone else");
  }

  const before = view(project);
  const sets = [];
  const params = [];
  for (const field of ["name", "description", "status"]) {
    if (payload[field] !== undefined) {
      params.push(payload[field]);
      sets.push(`${field} = $${params.length}`);
    }
  }

  if (sets.length === 0) {
    res.json(view(project));
    return;
  }

  params.push(project.id);
  const idIdx = params.length;
  params.push(project.version);
  const verIdx = params.length;

  const { rows } = await pgQuery(
    `UPDATE project.projects
       SET ${sets.join(", ")}, version = version + 1, updated_at = now()
     WHERE id = $${idIdx} AND version = $${verIdx}
     RETURNING ${PROJECT_COLS}`,
    params,
  );
  if (rows.length === 0) {
    throw new ApiError("VERSION_CONFLICT", "project was modified by someone else");
  }
  const updated = rows[0];

  await recordAudit({
    tenantId: principal.tenantId,
    action: "project.updated",
    resourceType: "project",
    resourceId: project.id,
    actorId: principal.userId,
    before,
    after: view(updated),
    requestId: req.requestId,
  });

  res.json(view(updated));
}

export async function archive(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const project = await loadProject(principal.orgId, req.params.projectId);

  await pgQuery(
    `UPDATE project.projects
       SET status = 'archived', version = version + 1, updated_at = now()
     WHERE id = $1`,
    [project.id],
  );

  await recordAudit({
    tenantId: principal.tenantId,
    action: "project.archived",
    resourceType: "project",
    resourceId: project.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.json({ id: project.id, archived: true });
}

export async function addMilestone(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const payload = milestoneSchema.parse(req.body);
  const project = await loadProject(principal.orgId, req.params.projectId);

  const { rows } = await pgQuery(
    `INSERT INTO project.milestones (project_id, name, due_on, status, sort_order)
     VALUES ($1, $2, $3, 'open',
             COALESCE((SELECT MAX(sort_order) + 1 FROM project.milestones WHERE project_id = $1), 0))
     RETURNING id, name, to_char(due_on, 'YYYY-MM-DD') AS due_on, status`,
    [project.id, payload.name, payload.due_at ?? null],
  );
  const m = rows[0];
  res.status(201).json({ id: m.id, name: m.name, due_at: m.due_on ?? null, status: m.status });
}

export async function addMember(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const payload = memberSchema.parse(req.body);
  const project = await loadProject(principal.orgId, req.params.projectId);

  const { rows } = await pgQuery(
    `INSERT INTO project.project_members (project_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING project_id, user_id, role`,
    [project.id, payload.user_id, payload.role],
  );
  const member = rows[0];
  res.status(201).json({
    project_id: member.project_id,
    user_id: member.user_id,
    role: member.role,
  });
}
