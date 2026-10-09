import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import * as audit from "../services/audit.service.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(calendar.events / calendar.event_participants) 전용 컨트롤러.
// 프론트(CalendarScreen)가 기대하는 응답 필드로 매핑해 돌려준다.
//   calendar  <- scope(visibility enum)  company/department -> "org",
//               team -> "project", private -> "personal"
//   start_at  <- starts_at,  end_at <- ends_at
//               (UTC 월시각 naive ISO 'YYYY-MM-DDTHH:MM:SS' 로 고정 — 프론트가 slice 로만 읽음)
//   project_id<- source_type='project' 일 때 source_id, 아니면 null
//   meeting_url/recurrence: perp_db 에 컬럼이 없어 항상 null
// 참석자는 calendar.event_participants(PK: event_id,user_id, response text).
// 모든 조회/쓰기는 company_id = principal.orgId 로 스코프, cancelled_at IS NULL.

const SCOPE_TO_CAL = { company: "org", department: "org", team: "project", private: "personal" };
const CAL_TO_SCOPE = { org: "company", project: "team", personal: "private" };

const eventSchema = z.object({
  title: z.string().min(1).max(200),
  calendar: z.enum(["personal", "org", "project"]).default("org"),
  project_id: z.string().nullable().optional(),
  start_at: z.string().min(1),
  end_at: z.string().min(1),
  location: z.string().nullable().optional(),
  meeting_url: z.string().url().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  all_day: z.boolean().optional(),
  department_id: z.string().nullable().optional(),
  attendee_ids: z.array(z.string()).default([]),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  calendar: z.enum(["personal", "org", "project"]).optional(),
  start_at: z.string().min(1).optional(),
  end_at: z.string().min(1).optional(),
  location: z.string().nullable().optional(),
  all_day: z.boolean().optional(),
  version: z.number().int().positive().optional(),
});

const attendeesSchema = z.object({ user_ids: z.array(z.string()).min(1) });
const responseSchema = z.object({ response: z.string().min(1).max(50) });

// SELECT/RETURNING 공용 컬럼. 날짜는 UTC 월시각 naive ISO 문자열로 고정.
const EVENT_COLS = `
  id, company_id, owner_id, title, description, location,
  to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS start_at,
  to_char(ends_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS end_at,
  all_day, scope, department_id, team_id, source_type, source_id, version`;

// perp_db row -> 프론트 기대 형태
const view = (e) => ({
  id: e.id,
  calendar: SCOPE_TO_CAL[e.scope] ?? "org",
  project_id: e.source_type === "project" ? (e.source_id ?? null) : null,
  title: e.title,
  description: e.description ?? "",
  start_at: e.start_at,
  end_at: e.end_at,
  location: e.location ?? null,
  meeting_url: null,
  recurrence: null,
  all_day: Boolean(e.all_day),
  version: e.version,
});

const attendeeView = (a) => ({
  user_id: a.user_id,
  response: a.response,
  name: a.name ?? null,
});

async function recordAudit(entry) {
  try {
    audit.record(entry);
  } catch {
    // 감사 로그(현재 SQLite) 실패는 무시 — 요청은 계속 성공시킨다.
  }
}

function assertWindow(startAt, endAt) {
  if (new Date(endAt) <= new Date(startAt)) {
    throw new ApiError("VALIDATION_ERROR", "end_at must be after start_at");
  }
}

// 같은 회사 소속의 활성 사용자만 참석자로 허용.
async function assertOrgMembers(orgId, userIds) {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const { rows } = await pgQuery(
    `SELECT id::text AS id FROM auth.users
     WHERE company_id::text = $1 AND id::text = ANY($2::text[])`,
    [orgId, unique],
  );
  const found = new Set(rows.map((r) => r.id));
  for (const userId of unique) {
    if (!found.has(String(userId))) {
      throw new ApiError("VALIDATION_ERROR", "attendee must be a member of the organization", {
        user_id: userId,
      });
    }
  }
  return unique;
}

// 회사 스코프로 단일 이벤트 조회(취소되지 않은 것).
async function loadEvent(orgId, eventId) {
  const { rows } = await pgQuery(
    `SELECT ${EVENT_COLS} FROM calendar.events
     WHERE id = $1 AND company_id::text = $2 AND cancelled_at IS NULL`,
    [eventId, orgId],
  );
  if (rows.length === 0) throw notFound("event");
  return rows[0];
}

async function listAttendees(eventId) {
  const { rows } = await pgQuery(
    `SELECT p.user_id::text AS user_id, p.response, u.name
     FROM calendar.event_participants p
     JOIN auth.users u ON u.id = p.user_id
     WHERE p.event_id = $1
     ORDER BY p.user_id`,
    [eventId],
  );
  return rows;
}

export async function create(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const payload = eventSchema.parse(req.body);
  assertWindow(payload.start_at, payload.end_at);

  const accepted = await assertOrgMembers(principal.orgId, payload.attendee_ids);
  const scope = CAL_TO_SCOPE[payload.calendar] ?? "company";

  const event = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO calendar.events
         (company_id, owner_id, title, description, location,
          starts_at, ends_at, all_day, scope, department_id)
       VALUES ($1, $2, $3, $4, $5,
               $6::timestamp AT TIME ZONE 'UTC', $7::timestamp AT TIME ZONE 'UTC',
               $8, $9::common.visibility, $10)
       RETURNING ${EVENT_COLS}`,
      [
        principal.orgId,
        principal.userId,
        payload.title,
        payload.description ?? "",
        payload.location ?? null,
        payload.start_at,
        payload.end_at,
        payload.all_day ?? false,
        scope,
        payload.department_id ?? null,
      ],
    );
    const created = rows[0];
    for (const userId of accepted) {
      await client.query(
        `INSERT INTO calendar.event_participants (event_id, user_id, response)
         VALUES ($1, $2, 'invited')
         ON CONFLICT (event_id, user_id) DO NOTHING`,
        [created.id, userId],
      );
    }
    return created;
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: "event.created",
    resourceType: "event",
    resourceId: event.id,
    actorId: principal.userId,
    after: { title: event.title, start_at: event.start_at },
    requestId: req.requestId,
  });

  const attendees = await listAttendees(event.id);
  res.status(201).json({ ...view(event), attendees: attendees.map(attendeeView) });
}

export async function list(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.read");

  const clauses = ["company_id::text = $1", "cancelled_at IS NULL"];
  const params = [principal.orgId];
  if (req.query.from) {
    params.push(req.query.from);
    clauses.push(`ends_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(req.query.to);
    clauses.push(`starts_at <= $${params.length}`);
  }
  if (req.query.calendar && CAL_TO_SCOPE[req.query.calendar]) {
    params.push(CAL_TO_SCOPE[req.query.calendar]);
    clauses.push(`scope = $${params.length}::common.visibility`);
  }
  params.push(Number(req.query.limit ?? 100));
  const limitIdx = params.length;

  const { rows } = await pgQuery(
    `SELECT ${EVENT_COLS} FROM calendar.events
     WHERE ${clauses.join(" AND ")}
     ORDER BY starts_at ASC
     LIMIT $${limitIdx}`,
    params,
  );
  res.json({ items: rows.map(view), next_cursor: null });
}

export async function detail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.read");
  const event = await loadEvent(principal.orgId, req.params.eventId);
  const attendees = await listAttendees(event.id);
  res.json({ ...view(event), attendees: attendees.map(attendeeView) });
}

export async function patch(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const payload = patchSchema.parse(req.body);
  const event = await loadEvent(principal.orgId, req.params.eventId);

  if (payload.version !== undefined && payload.version !== event.version) {
    throw new ApiError("VERSION_CONFLICT", "event was modified by someone else");
  }

  const startAt = payload.start_at ?? event.start_at;
  const endAt = payload.end_at ?? event.end_at;
  assertWindow(startAt, endAt);

  const before = view(event);
  const sets = [];
  const params = [];
  const push = (expr, value) => {
    params.push(value);
    sets.push(expr.replace("$$", `$${params.length}`));
  };
  if (payload.title !== undefined) push("title = $$", payload.title);
  if (payload.location !== undefined) push("location = $$", payload.location);
  if (payload.all_day !== undefined) push("all_day = $$", payload.all_day);
  if (payload.start_at !== undefined) push("starts_at = $$::timestamp AT TIME ZONE 'UTC'", payload.start_at);
  if (payload.end_at !== undefined) push("ends_at = $$::timestamp AT TIME ZONE 'UTC'", payload.end_at);
  if (payload.calendar !== undefined) {
    push("scope = $$::common.visibility", CAL_TO_SCOPE[payload.calendar] ?? "company");
  }

  if (sets.length === 0) {
    res.json(view(event));
    return;
  }

  params.push(event.id);
  const idIdx = params.length;
  params.push(event.version);
  const verIdx = params.length;

  const { rows } = await pgQuery(
    `UPDATE calendar.events
       SET ${sets.join(", ")}, version = version + 1, updated_at = now()
     WHERE id = $${idIdx} AND version = $${verIdx} AND cancelled_at IS NULL
     RETURNING ${EVENT_COLS}`,
    params,
  );
  if (rows.length === 0) {
    throw new ApiError("VERSION_CONFLICT", "event was modified by someone else");
  }
  const updated = rows[0];

  await recordAudit({
    tenantId: principal.tenantId,
    action: "event.updated",
    resourceType: "event",
    resourceId: event.id,
    actorId: principal.userId,
    before,
    after: view(updated),
    requestId: req.requestId,
  });

  res.json(view(updated));
}

export async function archive(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const event = await loadEvent(principal.orgId, req.params.eventId);

  await pgQuery(
    `UPDATE calendar.events
       SET cancelled_at = now(), version = version + 1, updated_at = now()
     WHERE id = $1 AND company_id::text = $2`,
    [event.id, principal.orgId],
  );

  await recordAudit({
    tenantId: principal.tenantId,
    action: "event.cancelled",
    resourceType: "event",
    resourceId: event.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.status(204).end();
}

export async function addEventAttendees(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const event = await loadEvent(principal.orgId, req.params.eventId);
  const payload = attendeesSchema.parse(req.body);
  const accepted = await assertOrgMembers(principal.orgId, payload.user_ids);

  for (const userId of accepted) {
    await pgQuery(
      `INSERT INTO calendar.event_participants (event_id, user_id, response)
       VALUES ($1, $2, 'invited')
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [event.id, userId],
    );
  }

  const attendees = await listAttendees(event.id);
  res.status(201).json({ items: attendees.map(attendeeView) });
}

export async function respond(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.read");
  const event = await loadEvent(principal.orgId, req.params.eventId);
  const payload = responseSchema.parse(req.body);

  const { rows } = await pgQuery(
    `INSERT INTO calendar.event_participants (event_id, user_id, response)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, user_id) DO UPDATE SET response = EXCLUDED.response
     RETURNING user_id::text AS user_id, response`,
    [event.id, principal.userId, payload.response],
  );
  res.json(attendeeView(rows[0]));
}
