import { z } from "zod";

import { db } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import {
  bumpVersion,
  getScoped,
  insert,
  listScoped,
  softDelete,
  update,
} from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { ApiError } from "../utils/errors.js";

const eventSchema = z.object({
  title: z.string().min(1).max(200),
  calendar: z.enum(["personal", "org", "project"]).default("org"),
  project_id: z.string().nullable().optional(),
  start_at: z.string().min(1),
  end_at: z.string().min(1),
  location: z.string().nullable().optional(),
  meeting_url: z.string().url().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  attendee_ids: z.array(z.string()).default([]),
});

const patchSchema = eventSchema
  .omit({ attendee_ids: true })
  .partial()
  .extend({ version: z.number().int().positive() });

const attendeesSchema = z.object({ user_ids: z.array(z.string()).min(1) });
const responseSchema = z.object({
  response: z.enum(["pending", "accepted", "declined", "tentative"]),
});

function assertWindow(startAt, endAt) {
  if (endAt <= startAt) {
    throw new ApiError("VALIDATION_ERROR", "end_at must be after start_at");
  }
}

function assertOrgMembers(principal, userIds) {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    const membership = db()
      .prepare(
        `SELECT id FROM membership
         WHERE tenant_id = ? AND org_id = ? AND user_id = ?
           AND status = 'active' AND deleted_at IS NULL`,
      )
      .get(principal.tenantId, principal.orgId, userId);
    if (!membership) {
      throw new ApiError("VALIDATION_ERROR", "attendee must be an active organization member", {
        user_id: userId,
      });
    }
  }
  return unique;
}

function eventView(event) {
  return {
    id: event.id,
    calendar: event.calendar,
    project_id: event.project_id,
    title: event.title,
    start_at: event.start_at,
    end_at: event.end_at,
    location: event.location,
    meeting_url: event.meeting_url,
    recurrence: event.recurrence,
    version: event.version,
  };
}

function attendeeView(attendee) {
  return {
    id: attendee.id,
    user_id: attendee.user_id,
    response: attendee.response,
  };
}

function addAttendees(principal, eventId, userIds) {
  const accepted = assertOrgMembers(principal, userIds);
  const created = [];
  for (const userId of accepted) {
    const existing = listScoped(
      "event_attendee",
      principal,
      [
        { sql: "event_id = ?", params: [eventId] },
        { sql: "user_id = ?", params: [userId] },
      ],
      { limit: 1 },
    )[0];
    if (!existing) {
      created.push(
        insert("event_attendee", {
          tenant_id: principal.tenantId,
          event_id: eventId,
          user_id: userId,
          created_by: principal.userId,
        }),
      );
    }
  }
  return created;
}

export function create(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const payload = eventSchema.parse(req.body);
  assertWindow(payload.start_at, payload.end_at);

  const event = insert("event", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    calendar: payload.calendar,
    project_id: payload.project_id ?? null,
    title: payload.title,
    start_at: payload.start_at,
    end_at: payload.end_at,
    location: payload.location ?? null,
    meeting_url: payload.meeting_url ?? null,
    recurrence: payload.recurrence ?? null,
    created_by: principal.userId,
  });
  const attendees = addAttendees(principal, event.id, payload.attendee_ids);
  audit.record({
    tenantId: principal.tenantId,
    action: "event.created",
    resourceType: "event",
    resourceId: event.id,
    actorId: principal.userId,
    after: { title: event.title, start_at: event.start_at },
    requestId: req.requestId,
  });
  res.status(201).json({ ...eventView(event), attendees: attendees.map(attendeeView) });
}

export function list(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.read");
  const window = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() })
    .refine(value => !value.from || !value.to || (Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 32 * 86_400_000), "조회 기간은 32일 이내여야 합니다")
    .parse(req.query);
  const filters = [];
  if (window.from) filters.push({ sql: "julianday(end_at) >= julianday(?)", params: [window.from] });
  if (window.to) filters.push({ sql: "julianday(start_at) < julianday(?)", params: [window.to] });
  if (req.query.project_id) {
    filters.push({ sql: "project_id = ?", params: [req.query.project_id] });
  }
  const rows = listScoped("event", principal, filters, {
    // 월 범위가 제한된 조회는 100건에서 잘라 날짜의 일정을 숨기지 않는다.
    limit: window.from && window.to ? -1 : Number(req.query.limit ?? 100),
    orderBy: "start_at ASC",
  });
  res.json({ items: rows.map(eventView), next_cursor: null });
}

export function detail(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.read");
  const event = getScoped("event", principal, req.params.eventId, "event");
  const attendees = listScoped(
    "event_attendee",
    principal,
    [{ sql: "event_id = ?", params: [event.id] }],
    { limit: 500 },
  );
  res.json({ ...eventView(event), attendees: attendees.map(attendeeView) });
}

export function patch(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const event = getScoped("event", principal, req.params.eventId, "event");
  const payload = patchSchema.parse(req.body);
  const startAt = payload.start_at ?? event.start_at;
  const endAt = payload.end_at ?? event.end_at;
  assertWindow(startAt, endAt);
  const { version, ...changes } = payload;
  const updated = bumpVersion("event", { ...event, version }, changes, principal.userId);
  res.json(eventView(updated));
}

export function archive(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const event = getScoped("event", principal, req.params.eventId, "event");
  softDelete("event", event.id, principal.userId);
  audit.record({
    tenantId: principal.tenantId,
    action: "event.archived",
    resourceType: "event",
    resourceId: event.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });
  res.status(204).end();
}

export function addEventAttendees(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.write");
  const event = getScoped("event", principal, req.params.eventId, "event");
  const payload = attendeesSchema.parse(req.body);
  const created = addAttendees(principal, event.id, payload.user_ids);
  res.status(201).json({ items: created.map(attendeeView) });
}

export function respond(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("event.read");
  const event = getScoped("event", principal, req.params.eventId, "event");
  const payload = responseSchema.parse(req.body);
  const attendee = listScoped(
    "event_attendee",
    principal,
    [
      { sql: "event_id = ?", params: [event.id] },
      { sql: "user_id = ?", params: [principal.userId] },
    ],
    { limit: 1 },
  )[0];
  if (!attendee) throw new ApiError("NOT_FOUND", "event attendee not found");
  const changed = update(
    "event_attendee",
    attendee.id,
    { response: payload.response },
    principal.userId,
  );
  res.json(attendeeView(changed));
}
