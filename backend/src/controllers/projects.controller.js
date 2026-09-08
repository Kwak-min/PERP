import { z } from "zod";
import { transaction } from '../config/db.js';
import { correctionDate, correctionVersion, assertCorrectionWindow } from '../services/daily-corrections.service.js';

import { assertBranchAccess } from "./members.controller.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { bumpVersion, getScoped, insert, listScoped, softDelete } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { ApiError } from "../utils/errors.js";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().default(""),
  department_id: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  budget_amount: z.number().int().default(0),
  visibility: z.string().default("org"),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  start_date: correctionDate.optional(),
  end_date: correctionDate.optional(),
  version: correctionVersion,
});

const milestoneSchema = z.object({
  name: z.string().min(1).max(200),
  due_at: z.string().nullable().optional(),
});

const view = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  status: p.status,
  owner_id: p.owner_id,
  department_id: p.department_id,
  visibility: p.visibility,
  start_date: p.start_date,
  end_date: p.end_date,
  budget_amount: p.budget_amount,
  version: p.version,
});

export function create(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const payload = createSchema.parse(req.body);

  const project = insert("project", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    description: payload.description,
    department_id: payload.department_id ?? null,
    start_date: payload.start_date ?? null,
    end_date: payload.end_date ?? null,
    budget_amount: payload.budget_amount,
    visibility: payload.visibility,
    owner_id: principal.userId,
    created_by: principal.userId,
  });

  insert("project_member", {
    tenant_id: principal.tenantId,
    project_id: project.id,
    user_id: principal.userId,
    role: "owner",
    created_by: principal.userId,
  });

  audit.record({
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

export function list(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.read");
  const filters = req.query.status ? [{ sql: "status = ?", params: [req.query.status] }] : [];
  // 부서 브랜치로 좁혀 보는 경우. 들어갈 권한이 없는 브랜치는 거부한다.
  if (req.query.department_id) {
    assertBranchAccess(principal, req.query.department_id);
    filters.push({ sql: "department_id = ?", params: [req.query.department_id] });
  }
  const rows = listScoped("project", principal, filters, { limit: Number(req.query.limit ?? 50) });
  res.json({ items: rows.map(view), next_cursor: null });
}

export function detail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.read");
  const project = getScoped("project", principal, req.params.projectId, "project");
  const members = listScoped(
    "project_member",
    principal,
    [{ sql: "project_id = ?", params: [project.id] }],
    { limit: 200 },
  );
  const milestones = listScoped(
    "milestone",
    principal,
    [{ sql: "project_id = ?", params: [project.id] }],
    { limit: 200 },
  );
  res.json({
    ...view(project),
    members: members.map((m) => ({ user_id: m.user_id, role: m.role })),
    milestones: milestones.map((m) => ({ id: m.id, name: m.name, due_at: m.due_at, status: m.status })),
  });
}

export function patch(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const payload = patchSchema.parse(req.body);
  const project = getScoped("project", principal, req.params.projectId, "project");

  if (payload.version !== undefined && payload.version !== project.version) {
    throw new ApiError("VERSION_CONFLICT", "project was modified by someone else");
  }

  assertCorrectionWindow(payload.start_date === undefined ? project.start_date : payload.start_date,
    payload.end_date === undefined ? project.end_date : payload.end_date);
  const before = view(project);
  const changes = {};
  for (const field of ["name", "description", "status", "start_date", "end_date"]) {
    if (payload[field] !== undefined) changes[field] = payload[field];
  }
  const updated = transaction(() => {
    const row = bumpVersion('project', project, changes, principal.userId);
    audit.record({ tenantId: principal.tenantId, action: 'project.updated', resourceType: 'project',
      resourceId: project.id, actorId: principal.userId, before, after: view(row), requestId: req.requestId });
    return row;
  })();

  res.json(view(updated));
}

export function archive(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const project = getScoped("project", principal, req.params.projectId, "project");
  softDelete("project", project.id, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "project.archived",
    resourceType: "project",
    resourceId: project.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.json({ id: project.id, archived: true });
}

export function addMilestone(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("project.write");
  const payload = milestoneSchema.parse(req.body);
  const project = getScoped("project", principal, req.params.projectId, "project");
  const milestone = insert("milestone", {
    tenant_id: principal.tenantId,
    project_id: project.id,
    name: payload.name,
    due_at: payload.due_at ?? null,
    created_by: principal.userId,
  });
  res.status(201).json({ id: milestone.id, name: milestone.name, due_at: milestone.due_at });
}

export { addLegacyProjectMember as addMember } from './projectMembers.controller.js';
