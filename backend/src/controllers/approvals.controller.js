import { z } from "zod";

import { pgQuery, pgTransaction } from "../config/pg.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { verifyPassword } from "../utils/crypto.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(org.approval_*) 전용 결재 컨트롤러.
// SQLite(config/db, models/base, approval.service, audit.service)를 전혀 쓰지 않는다.
// 모든 조회/쓰기는 company_id = principal.orgId 로 스코프.
//
// ── 단일 결재 모델 ↔ 프론트(다단계 steps) 매핑 ──────────────
// perp_db 결재는 "요청자(requester_id) → 단일 결재자(target_user_id)" 구조다.
// 프론트(ApprovalsScreen)가 기대하는 다단계 흐름은 1단계 결재선으로 합성해 돌려준다.
//   steps[0] = { approver_id: target_user_id, status, ... }
//   current_step = 1 상수
//   requester_id <- requester_id
//   amount       <- body.amount (jsonb, 없으면 0)
//   requires_reauth <- amount >= HIGH_AMOUNT (재인증 기준)
// perp_db status enum(common.approval_status): pending|approved|rejected|draft|withdrawn
//   프론트 라벨: pending=진행중, approved=승인, rejected=반려, withdrawn=회수
// 양식(approval_forms)은 (company_id, form_key) 유니크 → 같은 key 저장 시 revision+1.

// 재인증 기준 금액(원). 프론트 ApprovalFormsScreen 기본값과 맞춤.
const HIGH_AMOUNT = 1_000_000;

const formSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  fields: z.array(z.record(z.any())).default([]),
  route: z.array(z.record(z.any())).default([]),
});

const requestSchema = z.object({
  title: z.string().min(1).max(300),
  form_key: z.string().default("generic"),
  steps: z
    .array(
      z.object({
        approver_id: z.string(),
        mode: z.string().default("sequential"),
        kind: z.string().default("approve"),
      }),
    )
    .default([]),
  subject_type: z.string().nullable().optional(),
  subject_id: z.string().nullable().optional(),
  amount: z.number().int().default(0),
  due_at: z.string().nullable().optional(),
  payload: z.record(z.any()).default({}),
});

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject", "hold"]),
  comment: z.string().default(""),
  reauth_password: z.string().nullable().optional(),
});

const delegateSchema = z.object({ to_user_id: z.string() });

const toText = (v) => (v == null ? null : String(v));

// SELECT 시 타임스탬프는 ISO 문자열로 직렬화되도록 그대로 두고 view 에서 변환.
const REQUEST_COLS = `
  id, company_id, request_type, requester_id, target_user_id, payload, status,
  decided_by, decided_at, decision_note, title, form_key, body, form_revision,
  version, submitted_at, withdrawn_at, created_at`;

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const bodyAmount = (body) => {
  const n = Number(body?.amount);
  return Number.isFinite(n) ? n : 0;
};

// perp_db row -> 프론트(ApprovalsScreen) 기대 형태(목록용 경량 뷰)
function view(row) {
  const amount = bodyAmount(row.body);
  return {
    id: toText(row.id),
    title: row.title || row.request_type || "(제목 없음)",
    form_key: row.form_key ?? "generic",
    requester_id: toText(row.requester_id),
    amount,
    status: row.status,
    current_step: 1,
    requires_reauth: amount >= HIGH_AMOUNT,
  };
}

// 단일 결재자를 1단계 결재선으로 합성(프론트 다단계 호환).
function synthSteps(row) {
  if (row.target_user_id == null) return [];
  return [
    {
      ordinal: 1,
      approver_id: toText(row.target_user_id),
      mode: "sequential",
      kind: "approve",
      status:
        row.status === "approved" || row.status === "rejected"
          ? row.status
          : row.status === "withdrawn"
            ? "withdrawn"
            : "pending",
      comment: row.decision_note ?? "",
      decided_at: iso(row.decided_at) ?? null,
    },
  ];
}

// 상세 뷰(getRequest): 목록 뷰 + steps/history/본문 등 상세 필드.
function detailView(row, history = []) {
  return {
    ...view(row),
    request_type: row.request_type,
    subject_type: row.body?.subject_type ?? null,
    subject_id: row.body?.subject_id ?? null,
    due_at: row.body?.due_at ?? null,
    payload: row.payload ?? {},
    body: row.body ?? {},
    target_user_id: toText(row.target_user_id),
    decided_by: toText(row.decided_by),
    decided_at: iso(row.decided_at) ?? null,
    decision_note: row.decision_note ?? null,
    version: row.version,
    submitted_at: iso(row.submitted_at) ?? null,
    withdrawn_at: iso(row.withdrawn_at) ?? null,
    created_at: iso(row.created_at) ?? null,
    steps: synthSteps(row),
    history: history.map((h) => ({
      id: toText(h.id),
      actor_id: toText(h.actor_id),
      action: h.action,
      status: h.status,
      snapshot: h.snapshot ?? null,
      created_at: iso(h.created_at) ?? null,
    })),
  };
}

// (company_id, id) 스코프 단건 조회.
async function loadRequest(orgId, approvalId) {
  const { rows } = await pgQuery(
    `SELECT ${REQUEST_COLS} FROM org.approval_requests
      WHERE id::text = $1 AND company_id::text = $2`,
    [String(approvalId), orgId],
  );
  if (rows.length === 0) throw notFound("approval");
  return rows[0];
}

// 이력 1건 기록(동일 트랜잭션 클라이언트 사용). status 는 enum 유효값만.
async function insertHistory(client, { orgId, approvalId, actorId, action, status, snapshot }) {
  await client.query(
    `INSERT INTO org.approval_request_history
       (company_id, approval_id, actor_id, action, status, snapshot)
     VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::common.approval_status, $6::jsonb)`,
    [orgId, approvalId, actorId, action, status, JSON.stringify(snapshot ?? {})],
  );
}

// ── 양식 ────────────────────────────────────────────────────
export async function createForm(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.form.manage");
  const payload = formSchema.parse(req.body);

  // (company_id, form_key) 유니크 → 같은 key 면 revision+1, name/fields 갱신.
  // route 는 perp_db 컬럼이 없어 fields jsonb 로만 저장(route 는 보존 안 함).
  const { rows } = await pgQuery(
    `INSERT INTO org.approval_forms (company_id, form_key, name, fields, revision, active, created_by, updated_at)
     VALUES ($1::bigint, $2, $3, $4::jsonb, 1, true, $5::bigint, now())
     ON CONFLICT (company_id, form_key)
     DO UPDATE SET name = EXCLUDED.name,
                   fields = EXCLUDED.fields,
                   revision = org.approval_forms.revision + 1,
                   active = true,
                   updated_at = now()
     RETURNING id, form_key, revision`,
    [principal.orgId, payload.key, payload.name, JSON.stringify(payload.fields), principal.userId],
  );
  const form = rows[0];
  res.status(201).json({ id: toText(form.id), key: form.form_key, revision: form.revision });
}

export async function listForms(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const { rows } = await pgQuery(
    `SELECT id, form_key, name, fields, revision FROM org.approval_forms
      WHERE company_id::text = $1 AND active = true
      ORDER BY form_key ASC`,
    [principal.orgId],
  );
  res.json({
    items: rows.map((f) => ({
      id: toText(f.id),
      key: f.form_key,
      name: f.name,
      revision: f.revision,
      fields: f.fields ?? [],
      route: [], // perp_db 미보유
    })),
  });
}

// ── 결재 요청 생성 ──────────────────────────────────────────
export async function requestApproval(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const payload = requestSchema.parse(req.body);

  // 다단계 steps[] → 단일 결재자: 첫 단계의 approver_id 를 target_user_id 로.
  const targetUserId = payload.steps[0]?.approver_id ?? null;
  const body = {
    amount: payload.amount,
    subject_type: payload.subject_type ?? null,
    subject_id: payload.subject_id ?? null,
    due_at: payload.due_at ?? null,
    ...payload.payload,
  };

  const created = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO org.approval_requests
         (company_id, request_type, requester_id, target_user_id, payload, status,
          title, form_key, body, version, submitted_at)
       VALUES ($1::bigint, $2, $3::bigint, $4, $5::jsonb, 'pending',
               $6, $7, $8::jsonb, 1, now())
       RETURNING ${REQUEST_COLS}`,
      [
        principal.orgId,
        payload.form_key,
        principal.userId,
        targetUserId,
        JSON.stringify(payload.payload ?? {}),
        payload.title,
        payload.form_key,
        JSON.stringify(body),
      ],
    );
    const row = rows[0];
    await insertHistory(client, {
      orgId: principal.orgId,
      approvalId: row.id,
      actorId: principal.userId,
      action: "submitted",
      status: "pending",
      snapshot: { title: row.title, target_user_id: toText(row.target_user_id), amount: payload.amount },
    });
    return row;
  });

  res.status(201).json(detailView(created));
}

// ── 목록 ────────────────────────────────────────────────────
export async function listRequests(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const box = req.query.box ?? "inbox";
  const limit = Number(req.query.limit ?? 50);

  const params = [principal.orgId];
  let where;
  if (box === "sent") {
    params.push(principal.userId);
    where = `requester_id::text = $2`;
  } else if (box === "done") {
    params.push(principal.userId);
    where = `(requester_id::text = $2 OR target_user_id::text = $2)
             AND status IN ('approved','rejected','withdrawn')`;
  } else if (box === "cc") {
    // 단일 결재 모델엔 참조(cc) 개념이 없다 → 빈 목록.
    res.json({ items: [], box });
    return;
  } else {
    // inbox: 내가 결재자(target)이고 pending.
    params.push(principal.userId);
    where = `target_user_id::text = $2 AND status = 'pending'`;
  }
  params.push(limit);

  const { rows } = await pgQuery(
    `SELECT ${REQUEST_COLS} FROM org.approval_requests
      WHERE company_id::text = $1 AND ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  res.json({ items: rows.map(view), box });
}

export async function getRequest(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const row = await loadRequest(principal.orgId, req.params.approvalId);
  const { rows: history } = await pgQuery(
    `SELECT id, actor_id, action, status, snapshot, created_at
       FROM org.approval_request_history
      WHERE company_id::text = $1 AND approval_id = $2
      ORDER BY id ASC`,
    [principal.orgId, row.id],
  );
  res.json(detailView(row, history));
}

// ── 결재(승인/반려/보류) ────────────────────────────────────
export async function decide(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.decide");
  const payload = decisionSchema.parse(req.body);
  const row = await loadRequest(principal.orgId, req.params.approvalId);

  if (row.status !== "pending") {
    throw new ApiError("CONFLICT", `approval is already ${row.status}`);
  }
  if (toText(row.target_user_id) !== String(principal.userId)) {
    throw new ApiError("PERMISSION_DENIED", "you are not the approver of this request");
  }
  if (payload.decision === "reject" && !payload.comment.trim()) {
    throw new ApiError("VALIDATION_ERROR", "반려 사유(comment)는 필수입니다");
  }

  // 고액 승인은 재인증(비밀번호) 필요.
  const amount = bodyAmount(row.body);
  if (amount >= HIGH_AMOUNT && payload.decision === "approve") {
    const { rows: u } = await pgQuery(
      `SELECT password_hash FROM auth.users WHERE id = $1`,
      [principal.userId],
    );
    const hash = u[0]?.password_hash;
    if (!payload.reauth_password || !hash || !verifyPassword(payload.reauth_password, hash)) {
      throw new ApiError("PERMISSION_DENIED", "high-amount approval requires re-authentication");
    }
  }

  // hold 는 perp_db enum 에 없어 상태 변경 없이 이력만 남긴다(진행 중 유지).
  if (payload.decision === "hold") {
    await pgTransaction(async (client) => {
      await insertHistory(client, {
        orgId: principal.orgId,
        approvalId: row.id,
        actorId: principal.userId,
        action: "held",
        status: "pending",
        snapshot: { comment: payload.comment },
      });
    });
    const refreshed = await loadRequest(principal.orgId, row.id);
    res.json(detailView(refreshed));
    return;
  }

  const newStatus = payload.decision === "approve" ? "approved" : "rejected";

  const updated = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE org.approval_requests
          SET status = $1::common.approval_status,
              decided_by = $2::bigint,
              decided_at = now(),
              decision_note = $3,
              version = version + 1
        WHERE id = $4 AND company_id::text = $5 AND status = 'pending'
        RETURNING ${REQUEST_COLS}`,
      [newStatus, principal.userId, payload.comment, row.id, principal.orgId],
    );
    if (rows.length === 0) {
      throw new ApiError("CONFLICT", "approval was already decided");
    }
    const r = rows[0];
    await insertHistory(client, {
      orgId: principal.orgId,
      approvalId: r.id,
      actorId: principal.userId,
      action: payload.decision === "approve" ? "approved" : "rejected",
      status: newStatus,
      snapshot: { comment: payload.comment },
    });
    return r;
  });

  res.json(detailView(updated));
}

// ── 철회 ────────────────────────────────────────────────────
export async function withdraw(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.request");
  const row = await loadRequest(principal.orgId, req.params.approvalId);

  if (toText(row.requester_id) !== String(principal.userId)) {
    throw new ApiError("PERMISSION_DENIED", "only the requester can withdraw");
  }
  if (row.status !== "pending") {
    throw new ApiError("CONFLICT", `approval is already ${row.status}`);
  }

  const updated = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE org.approval_requests
          SET status = 'withdrawn', withdrawn_at = now(), version = version + 1
        WHERE id = $1 AND company_id::text = $2 AND status = 'pending'
        RETURNING ${REQUEST_COLS}`,
      [row.id, principal.orgId],
    );
    if (rows.length === 0) throw new ApiError("CONFLICT", "approval was already decided");
    const r = rows[0];
    await insertHistory(client, {
      orgId: principal.orgId,
      approvalId: r.id,
      actorId: principal.userId,
      action: "withdrawn",
      status: "withdrawn",
      snapshot: {},
    });
    return r;
  });

  res.json(detailView(updated));
}

// ── 위임(결재자 재지정) ─────────────────────────────────────
export async function delegate(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("approval.decide");
  const payload = delegateSchema.parse(req.body);
  const row = await loadRequest(principal.orgId, req.params.approvalId);

  if (row.status !== "pending") {
    throw new ApiError("CONFLICT", `approval is already ${row.status}`);
  }
  if (toText(row.target_user_id) !== String(principal.userId)) {
    throw new ApiError("PERMISSION_DENIED", "only the current approver can delegate");
  }

  const updated = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE org.approval_requests
          SET target_user_id = $1::bigint, version = version + 1
        WHERE id = $2 AND company_id::text = $3 AND status = 'pending'
        RETURNING ${REQUEST_COLS}`,
      [payload.to_user_id, row.id, principal.orgId],
    );
    if (rows.length === 0) throw new ApiError("CONFLICT", "approval was already decided");
    const r = rows[0];
    await insertHistory(client, {
      orgId: principal.orgId,
      approvalId: r.id,
      actorId: principal.userId,
      action: "delegated",
      status: "pending",
      snapshot: { to: payload.to_user_id, from: toText(principal.userId) },
    });
    return r;
  });

  res.json(detailView(updated));
}
