import { z } from "zod";

import { db } from "../config/db.js";
import { permissionsFor } from "../config/rbac.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, insert, listScoped, nowIso, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { createApproval } from "../services/approval.service.js";
import { notify } from "../services/notification.service.js";
import { ApiError } from "../utils/errors.js";

const DAY_MS = 86_400_000;

const attendanceSchema = z.object({
  member_id: z.string().min(1).optional(),
  on_date: z.string().min(8),
  kind: z.enum(["present", "late", "absent", "remote", "leave"]).default("present"),
  hours: z.number().int().min(0).max(24).default(8),
  source: z.enum(["manual", "qr", "import", "integration"]).default("manual"),
  note: z.string().default(""),
});

const attendanceCorrectionSchema = z.object({
  on_date: z.string().min(8),
  kind: z.enum(["present", "late", "absent", "remote", "leave"]).default("present"),
  hours: z.number().int().min(0).max(24).default(8),
  note: z.string().default(""),
});

const leaveSchema = z.object({
  kind: z.enum(["annual", "sick", "special", "unpaid"]).default("annual"),
  start_on: z.string().min(8),
  end_on: z.string().min(8),
  reason: z.string().default(""),
  substitute_id: z.string().nullable().optional(),
});

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().default(""),
});

const balanceSchema = z.object({
  member_id: z.string().min(1),
  kind: z.enum(["annual", "sick", "special", "unpaid"]).default("annual"),
  granted_days: z.number().int().min(0),
});

const LEAVE_KINDS = ["annual", "sick", "special", "unpaid"];

const leavePolicySchema = z.object({
  kind: z.enum(LEAVE_KINDS).default("annual"),
  default_days: z.number().int().min(0),
  carryover_enabled: z.boolean().default(false),
  carryover_max_days: z.number().int().min(0).default(0),
  expiry_note: z.string().default(""),
});

const postingSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  closes_on: z.string().nullable().optional(),
});

const applicationSchema = z.object({
  applicant_name: z.string().min(1),
  applicant_email: z.string().email(),
  applicant_phone: z.string().nullable().optional(),
  answers: z.record(z.unknown()).default({}),
  retain_until: z.string().nullable().optional(),
});

const stageSchema = z.object({
  stage: z.enum(["applied", "screening", "interview", "offer", "hired", "rejected"]),
  score: z.number().int().min(0).max(100).optional(),
});

const onboardingSchema = z.object({
  member_id: z.string().min(1),
  flow: z.enum(["onboarding", "offboarding"]).default("onboarding"),
  labels: z.array(z.string().min(1)).min(1),
});

function daysBetween(startOn, endOn) {
  const start = Date.parse(`${startOn}T00:00:00Z`);
  const end = Date.parse(`${endOn}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new ApiError("VALIDATION_ERROR", "날짜 형식은 YYYY-MM-DD 여야 합니다");
  }
  if (end < start) throw new ApiError("VALIDATION_ERROR", "end_on must be on/after start_on");
  return Math.round((end - start) / DAY_MS) + 1;
}

const attendanceView = (a) => ({
  id: a.id,
  member_id: a.member_id,
  on_date: a.on_date,
  kind: a.kind,
  hours: a.hours,
  source: a.source,
  note: a.note,
  check_in_at: a.check_in_at,
  check_out_at: a.check_out_at,
});

const attendanceCorrectionView = (c) => ({
  id: c.id,
  member_id: c.member_id,
  on_date: c.on_date,
  kind: c.kind,
  hours: c.hours,
  note: c.note,
  status: c.status,
  comment: c.comment,
  created_at: c.created_at,
  decided_at: c.decided_at,
});

const leaveView = (l) => ({
  id: l.id,
  member_id: l.member_id,
  kind: l.kind,
  start_on: l.start_on,
  end_on: l.end_on,
  days: daysBetween(l.start_on, l.end_on),
  reason: l.reason,
  status: l.status,
  substitute_id: l.substitute_id,
});

const policyView = (p) => ({
  id: p.id,
  kind: p.kind,
  default_days: p.default_days,
  carryover_enabled: Boolean(p.carryover_enabled),
  carryover_max_days: p.carryover_max_days,
  expiry_note: p.expiry_note,
});

const applicationView = (a) => ({
  id: a.id,
  posting_id: a.posting_id,
  applicant_name: a.applicant_name,
  applicant_email: a.applicant_email,
  applicant_phone: a.applicant_phone,
  answers: a.answers ? JSON.parse(a.answers) : {},
  score: a.score,
  stage: a.stage,
  retain_until: a.retain_until,
});


export function checkAttendance(req, res) {
  const principal = resolvePrincipal(req);
  const payload = attendanceSchema.parse(req.body);
  const memberId = payload.member_id ?? principal.userId;
  if (memberId !== principal.userId) principal.require("attendance.write");

  const existing = listScoped(
    "attendance",
    principal,
    [
      { sql: "member_id = ?", params: [memberId] },
      { sql: "on_date = ?", params: [payload.on_date] },
    ],
    { limit: 1 },
  )[0];
  if (existing) {
    throw new ApiError("CONFLICT", "해당 날짜의 근태 기록이 이미 있습니다", {
      attendance_id: existing.id,
    });
  }

  const row = insert("attendance", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    member_id: memberId,
    on_date: payload.on_date,
    kind: payload.kind,
    hours: payload.hours,
    source: payload.source,
    note: payload.note,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "attendance.recorded",
    resourceType: "attendance",
    resourceId: row.id,
    actorId: principal.userId,
    after: { member_id: memberId, on_date: row.on_date, kind: row.kind },
    requestId: req.requestId,
  });

  res.status(201).json(attendanceView(row));
}

export function listAttendance(req, res) {
  const principal = resolvePrincipal(req);
  const memberId = req.query.member_id ?? principal.userId;
  if (memberId !== principal.userId) principal.require("attendance.read");

  const filters = [{ sql: "member_id = ?", params: [memberId] }];
  if (req.query.from) filters.push({ sql: "on_date >= ?", params: [req.query.from] });
  if (req.query.to) filters.push({ sql: "on_date <= ?", params: [req.query.to] });

  const rows = listScoped("attendance", principal, filters, {
    limit: Number(req.query.limit ?? 200),
    orderBy: "on_date DESC",
  });

  res.json({
    items: rows.map(attendanceView),
    summary: {
      total_days: rows.length,
      total_hours: rows.reduce((sum, r) => sum + r.hours, 0),
      by_kind: rows.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {}),
    },
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function todaysAttendance(principal) {
  return listScoped(
    "attendance",
    principal,
    [
      { sql: "member_id = ?", params: [principal.userId] },
      { sql: "on_date = ?", params: [todayIso()] },
    ],
    { limit: 1 },
  )[0];
}

/** 출근 버튼: 현재 시각을 check_in_at으로 저장한다(SFR-007 초안, HR-002 "출석"). */
export function checkIn(req, res) {
  const principal = resolvePrincipal(req);
  const existing = todaysAttendance(principal);
  if (existing?.check_in_at) {
    throw new ApiError("CONFLICT", "이미 출근 처리되었습니다");
  }
  const now = nowIso();
  const row = existing
    ? update("attendance", existing.id, { check_in_at: now }, principal.userId)
    : insert("attendance", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        member_id: principal.userId,
        on_date: todayIso(),
        kind: "present",
        hours: 0,
        source: "manual",
        check_in_at: now,
        created_by: principal.userId,
      });

  audit.record({
    tenantId: principal.tenantId,
    action: "attendance.checked_in",
    resourceType: "attendance",
    resourceId: row.id,
    actorId: principal.userId,
    after: { check_in_at: row.check_in_at },
    requestId: req.requestId,
  });

  res.status(existing ? 200 : 201).json(attendanceView(row));
}

/** 퇴근 버튼: check_out_at을 저장하고 출퇴근 시각 차이로 hours를 계산한다. */
export function checkOut(req, res) {
  const principal = resolvePrincipal(req);
  const existing = todaysAttendance(principal);
  if (!existing?.check_in_at) {
    throw new ApiError("CONFLICT", "출근 기록이 없습니다");
  }
  if (existing.check_out_at) {
    throw new ApiError("CONFLICT", "이미 퇴근 처리되었습니다");
  }
  const now = nowIso();
  const hours = Math.max(0, Math.round((Date.parse(now) - Date.parse(existing.check_in_at)) / 3_600_000));
  const row = update("attendance", existing.id, { check_out_at: now, hours }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "attendance.checked_out",
    resourceType: "attendance",
    resourceId: row.id,
    actorId: principal.userId,
    after: { check_out_at: row.check_out_at, hours: row.hours },
    requestId: req.requestId,
  });

  res.json(attendanceView(row));
}

/** 근태 수정요청 1단계: 신청. HR-001의 본인수정 승인과 동일 패턴 — 본인만 신청 가능. */
export function createAttendanceCorrection(req, res) {
  const principal = resolvePrincipal(req);
  const payload = attendanceCorrectionSchema.parse(req.body);

  const row = insert("attendance_correction_request", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    member_id: principal.userId,
    on_date: payload.on_date,
    kind: payload.kind,
    hours: payload.hours,
    note: payload.note,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "attendance_correction.created",
    resourceType: "attendance_correction_request",
    resourceId: row.id,
    actorId: principal.userId,
    after: { on_date: row.on_date, kind: row.kind, hours: row.hours },
    requestId: req.requestId,
  });

  res.status(201).json(attendanceCorrectionView(row));
}

export function listMyAttendanceCorrections(req, res) {
  const principal = resolvePrincipal(req);
  const rows = listScoped(
    "attendance_correction_request",
    principal,
    [{ sql: "member_id = ?", params: [principal.userId] }],
    { limit: 100 },
  );
  res.json({ items: rows.map(attendanceCorrectionView) });
}

/** "관리" 탭 노출 여부는 프론트가 이 호출의 403 여부로 판단한다(HR-001/HR-003과 동일 관용구). */
export function listPendingAttendanceCorrections(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("attendance.write");
  const rows = listScoped(
    "attendance_correction_request",
    principal,
    [{ sql: "status = ?", params: ["pending"] }],
    { limit: 200 },
  );
  res.json({ items: rows.map(attendanceCorrectionView) });
}

/** 근태 수정요청 2단계: 승인/반려. 승인 시에만 실제 attendance 기록에 반영한다. */
export function decideAttendanceCorrection(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("attendance.write");
  const payload = decisionSchema.parse(req.body);
  const correction = getScoped(
    "attendance_correction_request",
    principal,
    req.params.correctionId,
    "attendance_correction_request",
  );
  if (correction.status !== "pending") {
    throw new ApiError("CONFLICT", `이미 처리된 요청입니다: ${correction.status}`);
  }

  const status = payload.decision === "approve" ? "approved" : "rejected";
  const updated = update(
    "attendance_correction_request",
    correction.id,
    { status, comment: payload.comment, decided_by: principal.userId, decided_at: nowIso() },
    principal.userId,
  );

  if (status === "approved") {
    const existing = listScoped(
      "attendance",
      principal,
      [
        { sql: "member_id = ?", params: [correction.member_id] },
        { sql: "on_date = ?", params: [correction.on_date] },
      ],
      { limit: 1 },
    )[0];
    if (existing) {
      update(
        "attendance",
        existing.id,
        { kind: correction.kind, hours: correction.hours, note: correction.note },
        principal.userId,
      );
    } else {
      insert("attendance", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        member_id: correction.member_id,
        on_date: correction.on_date,
        kind: correction.kind,
        hours: correction.hours,
        source: "manual",
        note: correction.note,
        created_by: principal.userId,
      });
    }
  }

  audit.record({
    tenantId: principal.tenantId,
    action: `attendance_correction.${status}`,
    resourceType: "attendance_correction_request",
    resourceId: correction.id,
    actorId: principal.userId,
    before: { status: correction.status },
    after: { status },
    requestId: req.requestId,
  });

  notify({
    tenantId: principal.tenantId,
    recipientId: correction.member_id,
    type: `attendance_correction.${status}`,
    title: status === "approved" ? "근태 수정요청이 승인되었습니다" : "근태 수정요청이 반려되었습니다",
    body: payload.comment,
    relatedType: "attendance_correction_request",
    relatedId: correction.id,
    dedupeKey: `attendance-correction-decision:${correction.id}`,
  });

  res.json(attendanceCorrectionView(updated));
}


export function requestLeave(req, res) {
  const principal = resolvePrincipal(req);
  const payload = leaveSchema.parse(req.body);
  const days = daysBetween(payload.start_on, payload.end_on);

  const balance = listScoped(
    "leave_balance",
    principal,
    [
      { sql: "member_id = ?", params: [principal.userId] },
      { sql: "kind = ?", params: [payload.kind] },
    ],
    { limit: 1 },
  )[0];
  if (balance && balance.used_days + days > balance.granted_days) {
    throw new ApiError("VALIDATION_ERROR", "잔여 휴가일수가 부족합니다", {
      granted_days: balance.granted_days,
      used_days: balance.used_days,
      requested_days: days,
    });
  }

  const row = insert("leave_request", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    member_id: principal.userId,
    kind: payload.kind,
    start_on: payload.start_on,
    end_on: payload.end_on,
    reason: payload.reason,
    substitute_id: payload.substitute_id ?? null,
    created_by: principal.userId,
  });

  if (payload.substitute_id) {
    notify({
      tenantId: principal.tenantId,
      recipientId: payload.substitute_id,
      type: "leave.substitute_requested",
      title: `대직 요청: ${payload.start_on} ~ ${payload.end_on}`,
      relatedType: "leave_request",
      relatedId: row.id,
      dedupeKey: `leave-sub:${row.id}`,
    });
  }

  audit.record({
    tenantId: principal.tenantId,
    action: "leave.requested",
    resourceType: "leave_request",
    resourceId: row.id,
    actorId: principal.userId,
    after: { kind: row.kind, start_on: row.start_on, end_on: row.end_on },
    requestId: req.requestId,
  });

  // 휴가 신청은 결재함으로 넘어간다. 결재자가 없으면 접수만 하고 넘어간다.
  const approvers = leaveApprovers(principal);
  let approvalId = null;
  if (approvers.length > 0) {
    const approval = createApproval(principal, {
      title: `휴가 신청 ${payload.start_on} ~ ${payload.end_on} (${days}일)`,
      formKey: "leave",
      steps: approvers.map((approverId) => ({ approver_id: approverId })),
      subjectType: "leave_request",
      subjectId: row.id,
      payload: {
        kind: payload.kind,
        start_on: payload.start_on,
        end_on: payload.end_on,
        days,
        reason: payload.reason,
      },
    });
    approvalId = approval.id;
  }

  res.status(201).json({ ...leaveView(row), approval_id: approvalId, days });
}

/** 휴가를 결재할 수 있는 사람(신청자 제외). 없으면 결재 없이 접수만 한다. */
function leaveApprovers(principal) {
  const rows = listScoped("membership", principal, [{ sql: "status = ?", params: ["active"] }], {
    limit: 500,
  });
  return rows
    .filter((membership) => {
      const permissions = permissionsFor((membership.roles ?? "").split(",").filter(Boolean));
      return permissions.has("*") || permissions.has("leave.approve");
    })
    .map((membership) => membership.user_id)
    .filter((userId) => userId !== principal.userId);
}

export function leaveCalendar(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.read");

  const filters = [{ sql: "status IN ('pending','approved')", params: [] }];
  if (req.query.from) filters.push({ sql: "end_on >= ?", params: [req.query.from] });
  if (req.query.to) filters.push({ sql: "start_on <= ?", params: [req.query.to] });

  const rows = listScoped("leave_request", principal, filters, {
    limit: Number(req.query.limit ?? 500),
    orderBy: "start_on ASC",
  });

  // 달력에는 이름·휴가 종류·기간·상태만 노출한다.
  res.json({
    items: rows.map((row) => {
      const user = db().prepare("SELECT name FROM app_user WHERE id = ?").get(row.member_id);
      return {
        leave_id: row.id,
        member_id: row.member_id,
        member_name: user?.name ?? "구성원",
        kind: row.kind,
        start_on: row.start_on,
        end_on: row.end_on,
        status: row.status,
      };
    }),
  });
}

export function listLeaves(req, res) {
  const principal = resolvePrincipal(req);
  const filters = [];
  if (req.query.status) filters.push({ sql: "status = ?", params: [req.query.status] });
  if (!principal.has("leave.approve")) {
    filters.push({ sql: "member_id = ?", params: [principal.userId] });
  } else if (req.query.member_id) {
    filters.push({ sql: "member_id = ?", params: [req.query.member_id] });
  }

  const rows = listScoped("leave_request", principal, filters, {
    limit: Number(req.query.limit ?? 100),
    orderBy: "start_on DESC",
  });
  res.json({ items: rows.map(leaveView) });
}

export function decideLeave(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("leave.approve");
  const payload = decisionSchema.parse(req.body);
  const leave = getScoped("leave_request", principal, req.params.leaveId, "leave_request");
  if (leave.status !== "pending") {
    throw new ApiError("CONFLICT", `이미 처리된 휴가 신청입니다: ${leave.status}`);
  }

  const status = payload.decision === "approve" ? "approved" : "rejected";
  const updated = update("leave_request", leave.id, { status }, principal.userId);

  if (status === "approved") {
    const days = daysBetween(leave.start_on, leave.end_on);
    const balance = listScoped(
      "leave_balance",
      principal,
      [
        { sql: "member_id = ?", params: [leave.member_id] },
        { sql: "kind = ?", params: [leave.kind] },
      ],
      { limit: 1 },
    )[0];
    if (balance) {
      update("leave_balance", balance.id, { used_days: balance.used_days + days }, principal.userId);
    }
  }

  notify({
    tenantId: principal.tenantId,
    recipientId: leave.member_id,
    type: `leave.${status}`,
    title: status === "approved" ? "휴가가 승인되었습니다" : "휴가가 반려되었습니다",
    body: payload.comment,
    relatedType: "leave_request",
    relatedId: leave.id,
    dedupeKey: `leave-decision:${leave.id}`,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: `leave.${status}`,
    resourceType: "leave_request",
    resourceId: leave.id,
    actorId: principal.userId,
    before: { status: leave.status },
    after: { status },
    requestId: req.requestId,
  });

  res.json(leaveView(updated));
}

export function listBalances(req, res) {
  const principal = resolvePrincipal(req);
  const memberId = req.query.member_id ?? principal.userId;
  if (memberId !== principal.userId) principal.require("attendance.read");

  const rows = listScoped(
    "leave_balance",
    principal,
    [{ sql: "member_id = ?", params: [memberId] }],
    { limit: 50 },
  );
  res.json({
    items: rows.map((b) => ({
      id: b.id,
      member_id: b.member_id,
      kind: b.kind,
      granted_days: b.granted_days,
      used_days: b.used_days,
      remaining_days: b.granted_days - b.used_days,
    })),
  });
}

export function grantBalance(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("leave.approve");
  const payload = balanceSchema.parse(req.body);

  const existing = listScoped(
    "leave_balance",
    principal,
    [
      { sql: "member_id = ?", params: [payload.member_id] },
      { sql: "kind = ?", params: [payload.kind] },
    ],
    { limit: 1 },
  )[0];

  const row = existing
    ? update("leave_balance", existing.id, { granted_days: payload.granted_days }, principal.userId)
    : insert("leave_balance", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        member_id: payload.member_id,
        kind: payload.kind,
        granted_days: payload.granted_days,
        created_by: principal.userId,
      });

  audit.record({
    tenantId: principal.tenantId,
    action: "leave_balance.granted",
    resourceType: "leave_balance",
    resourceId: row.id,
    actorId: principal.userId,
    before: existing ? { granted_days: existing.granted_days } : null,
    after: { member_id: row.member_id, kind: row.kind, granted_days: row.granted_days },
    requestId: req.requestId,
  });

  res.status(existing ? 200 : 201).json({
    id: row.id,
    member_id: row.member_id,
    kind: row.kind,
    granted_days: row.granted_days,
    used_days: row.used_days,
    remaining_days: row.granted_days - row.used_days,
  });
}

export function listLeavePolicies(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("leave.approve");
  const rows = listScoped("leave_policy", principal, [], { limit: 50 });
  res.json({ items: rows.map(policyView) });
}

export function upsertLeavePolicy(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("leave.approve");
  const payload = leavePolicySchema.parse(req.body);

  const existing = listScoped(
    "leave_policy",
    principal,
    [{ sql: "kind = ?", params: [payload.kind] }],
    { limit: 1 },
  )[0];

  const patch = {
    default_days: payload.default_days,
    carryover_enabled: payload.carryover_enabled,
    carryover_max_days: payload.carryover_max_days,
    expiry_note: payload.expiry_note,
  };
  const row = existing
    ? update("leave_policy", existing.id, patch, principal.userId)
    : insert("leave_policy", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        kind: payload.kind,
        ...patch,
        created_by: principal.userId,
      });

  audit.record({
    tenantId: principal.tenantId,
    action: "leave_policy.updated",
    resourceType: "leave_policy",
    resourceId: row.id,
    actorId: principal.userId,
    before: existing ? policyView(existing) : null,
    after: policyView(row),
    requestId: req.requestId,
  });

  res.status(existing ? 200 : 201).json(policyView(row));
}

export function leaveStats(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("leave.approve");

  const balances = listScoped("leave_balance", principal, [], { limit: 1000 });
  const items = balances.map((b) => ({
    member_id: b.member_id,
    kind: b.kind,
    granted_days: b.granted_days,
    used_days: b.used_days,
    remaining_days: b.granted_days - b.used_days,
    usage_rate: b.granted_days > 0 ? Math.round((1000 * b.used_days) / b.granted_days) / 10 : 0,
  }));

  const totalGranted = items.reduce((sum, item) => sum + item.granted_days, 0);
  const totalUsed = items.reduce((sum, item) => sum + item.used_days, 0);

  res.json({
    items,
    totals: {
      granted_days: totalGranted,
      used_days: totalUsed,
      usage_rate: totalGranted > 0 ? Math.round((1000 * totalUsed) / totalGranted) / 10 : 0,
    },
    formula: "소진율 = 사용일수 / 부여일수 × 100",
    generated_at: new Date().toISOString(),
  });
}


export function createPosting(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("recruitment.manage");
  const payload = postingSchema.parse(req.body);

  const row = insert("job_posting", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    title: payload.title,
    description: payload.description,
    closes_on: payload.closes_on ?? null,
    created_by: principal.userId,
  });

  res.status(201).json({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    closes_on: row.closes_on,
  });
}

export function listPostings(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("recruitment.manage");
  const filters = req.query.status ? [{ sql: "status = ?", params: [req.query.status] }] : [];
  const rows = listScoped("job_posting", principal, filters, {
    limit: Number(req.query.limit ?? 100),
  });
  res.json({
    items: rows.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      closes_on: p.closes_on,
      created_at: p.created_at,
    })),
  });
}

export function closePosting(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("recruitment.manage");
  const posting = getScoped("job_posting", principal, req.params.postingId, "job_posting");
  const updated = update("job_posting", posting.id, { status: "closed" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "posting.closed",
    resourceType: "job_posting",
    resourceId: posting.id,
    actorId: principal.userId,
    before: { status: posting.status },
    after: { status: updated.status },
    requestId: req.requestId,
  });

  res.json({ id: updated.id, status: updated.status });
}

export function apply(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("recruitment.manage");
  const payload = applicationSchema.parse(req.body);
  const posting = getScoped("job_posting", principal, req.params.postingId, "job_posting");
  if (posting.status !== "open") {
    throw new ApiError("CONFLICT", "마감된 공고입니다");
  }

  const row = insert("application", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    posting_id: posting.id,
    applicant_name: payload.applicant_name,
    applicant_email: payload.applicant_email,
    applicant_phone: payload.applicant_phone ?? null,
    answers: JSON.stringify(payload.answers),
    retain_until: payload.retain_until ?? null,
    created_by: principal.userId,
  });

  res.status(201).json(applicationView(row));
}

export function listApplications(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("recruitment.manage");
  const filters = [];
  if (req.params.postingId) filters.push({ sql: "posting_id = ?", params: [req.params.postingId] });
  if (req.query.stage) filters.push({ sql: "stage = ?", params: [req.query.stage] });
  const rows = listScoped("application", principal, filters, {
    limit: Number(req.query.limit ?? 200),
  });
  res.json({ items: rows.map(applicationView) });
}

export function moveStage(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("recruitment.manage");
  const payload = stageSchema.parse(req.body);
  const application = getScoped("application", principal, req.params.applicationId, "application");

  const patch = { stage: payload.stage };
  if (payload.score !== undefined) patch.score = payload.score;
  const updated = update("application", application.id, patch, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "application.stage_changed",
    resourceType: "application",
    resourceId: application.id,
    actorId: principal.userId,
    before: { stage: application.stage },
    after: { stage: updated.stage },
    requestId: req.requestId,
  });

  res.json(applicationView(updated));
}


export function createOnboarding(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("member.write");
  const payload = onboardingSchema.parse(req.body);

  const items = payload.labels.map((label) =>
    insert("onboarding_item", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      member_id: payload.member_id,
      flow: payload.flow,
      label,
      created_by: principal.userId,
    }),
  );

  notify({
    tenantId: principal.tenantId,
    recipientId: payload.member_id,
    type: `hr.${payload.flow}_started`,
    title: payload.flow === "onboarding" ? "온보딩 체크리스트가 생성됐습니다" : "오프보딩 체크리스트가 생성됐습니다",
    relatedType: "onboarding_item",
    relatedId: items[0].id,
  });

  res.status(201).json({
    items: items.map((i) => ({ id: i.id, label: i.label, flow: i.flow, done: Boolean(i.done) })),
  });
}

export function listOnboarding(req, res) {
  const principal = resolvePrincipal(req);
  const memberId = req.query.member_id ?? principal.userId;
  if (memberId !== principal.userId) principal.require("member.read");

  const filters = [{ sql: "member_id = ?", params: [memberId] }];
  if (req.query.flow) filters.push({ sql: "flow = ?", params: [req.query.flow] });
  const rows = listScoped("onboarding_item", principal, filters, {
    limit: Number(req.query.limit ?? 200),
    orderBy: "created_at ASC",
  });

  res.json({
    items: rows.map((i) => ({
      id: i.id,
      member_id: i.member_id,
      flow: i.flow,
      label: i.label,
      done: Boolean(i.done),
    })),
    progress: {
      total: rows.length,
      done: rows.filter((i) => i.done).length,
    },
  });
}

export function completeOnboardingItem(req, res) {
  const principal = resolvePrincipal(req);
  const item = getScoped("onboarding_item", principal, req.params.itemId, "onboarding_item");
  if (item.member_id !== principal.userId) principal.require("member.write");
  const updated = update("onboarding_item", item.id, { done: 1 }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "onboarding_item.completed",
    resourceType: "onboarding_item",
    resourceId: item.id,
    actorId: principal.userId,
    before: { done: Boolean(item.done) },
    after: { done: true },
    requestId: req.requestId,
  });

  res.json({ id: updated.id, label: updated.label, done: Boolean(updated.done) });
}
