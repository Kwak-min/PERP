import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import * as audit from "../services/audit.service.js";
import { notify } from "../services/notification.service.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(asset.assets / asset.history / asset.reservations) 전용 컨트롤러.
// SQLite(config/db, models/base) 를 전혀 쓰지 않는다.
// 모든 조회/쓰기는 company_id = principal.orgId 로 스코프.
//
// 프론트(AssetsScreen) 기대 필드 매핑 (프론트 수정 금지):
//   asset_no     <- code          (code 가 null 이면 빈 문자열)
//   custodian_id <- assignee_id   (bigint, pg 가 문자열로 반환)
//   quantity     : 상수 1         (perp_db 에 수량 개념 없음)
//   threshold    : 상수 0
//   low_stock    : 상수 false
// asset.reservations 는 자산 전용(checked_in_at 없음). 상태 문자열로 흐름 표현.

const assetSchema = z.object({
  // 프론트는 asset_no 로 보내고, perp_db 의 code 에 저장한다.
  asset_no: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  name: z.string().min(1),
  category: z.string().default("equipment"),
  location: z.string().nullable().optional(),
  // 프론트는 custodian_id 로 보내고, perp_db 의 assignee_id 에 저장한다.
  custodian_id: z.union([z.string(), z.number()]).nullable().optional(),
  assignee_id: z.union([z.string(), z.number()]).nullable().optional(),
  note: z.string().nullable().optional(),
  acquired_on: z.string().nullable().optional(),
  // 프론트 호환용으로 받되 perp_db 스키마엔 없어 저장하지 않음
  quantity: z.number().int().optional(),
  threshold: z.number().int().optional(),
});

const actionSchema = z.object({
  action: z.enum(["loan", "return", "inspect", "repair", "lost", "damaged", "dispose"]),
  detail: z.string().default(""),
});

const reservationSchema = z.object({
  // asset_id 가 1순위, resource_id 는 하위호환 별칭.
  asset_id: z.union([z.string(), z.number()]).optional(),
  resource_id: z.union([z.string(), z.number()]).optional(),
  // starts_at/ends_at 1순위, start_at/end_at 하위호환 별칭.
  starts_at: z.string().optional(),
  ends_at: z.string().optional(),
  start_at: z.string().optional(),
  end_at: z.string().optional(),
  note: z.string().nullable().optional(),
});

// perp_db asset.assets 의 CHECK 제약: status ∈ {in_use, stored, repair, disposed, lost}.
// 'available'/'loaned' 같은 값은 DB 가 거부하므로 허용값으로 매핑한다.
//   available(대여가능) == 'stored',  loan(대여) == 'in_use'
//   damaged 는 전용 상태가 없어 가장 가까운 'repair' 로 보낸다.
const AVAILABLE_STATUS = "stored";
const STATUS_BY_ACTION = {
  loan: "in_use",
  return: "stored",
  inspect: "stored",
  repair: "repair",
  lost: "lost",
  damaged: "repair",
  dispose: "disposed",
};

const ASSET_COLS = `
  id, company_id, name, code, category, status, assignee_id, location,
  to_char(acquired_on, 'YYYY-MM-DD') AS acquired_on, note, version`;

// perp_db row -> 프론트 기대 형태
const view = (a) => ({
  id: a.id,
  asset_no: a.code ?? "",
  name: a.name,
  category: a.category ?? "",
  quantity: 1,
  threshold: 0,
  status: a.status,
  location: a.location ?? null,
  custodian_id: a.assignee_id ?? null,
  low_stock: false,
  version: a.version,
});

async function recordAudit(entry) {
  try {
    audit.record(entry);
  } catch {
    // 감사 로그 저장(현재 SQLite)이 실패해도 요청은 계속 성공시킨다.
  }
}

async function safeNotify(entry) {
  try {
    notify(entry);
  } catch {
    // 알림 저장 실패가 본 요청을 막지 않도록 한다.
  }
}

async function loadAsset(orgId, assetId) {
  const { rows } = await pgQuery(
    `SELECT ${ASSET_COLS} FROM asset.assets WHERE id = $1 AND company_id::text = $2`,
    [assetId, orgId],
  );
  if (rows.length === 0) throw notFound("asset");
  return rows[0];
}

// 예약을 회사 스코프로 로드(asset 조인). 없으면 404.
async function loadReservation(orgId, reservationId) {
  const { rows } = await pgQuery(
    `SELECT r.id, r.asset_id, r.reserved_by, r.starts_at, r.ends_at, r.status, r.note
       FROM asset.reservations r
       JOIN asset.assets a ON a.id = r.asset_id
      WHERE r.id = $1 AND a.company_id::text = $2`,
    [reservationId, orgId],
  );
  if (rows.length === 0) throw notFound("reservation");
  return rows[0];
}

export async function createAsset(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.write");
  const payload = assetSchema.parse(req.body);

  const code = payload.code ?? payload.asset_no ?? null;
  const assignee = payload.assignee_id ?? payload.custodian_id ?? null;

  const asset = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO asset.assets
         (company_id, name, code, category, status, assignee_id, location, acquired_on, note)
       VALUES ($1, $2, $3, $4, 'stored', $5, $6, $7, $8)
       RETURNING ${ASSET_COLS}`,
      [
        principal.orgId,
        payload.name,
        code,
        payload.category,
        assignee == null ? null : String(assignee),
        payload.location ?? null,
        payload.acquired_on ?? null,
        payload.note ?? null,
      ],
    );
    const created = rows[0];
    await client.query(
      `INSERT INTO asset.history (asset_id, event_type, actor_id, note)
       VALUES ($1, 'registered', $2, $3)`,
      [created.id, String(principal.userId), "자산 등록"],
    );
    return created;
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: "asset.created",
    resourceType: "asset",
    resourceId: asset.id,
    actorId: principal.userId,
    after: { name: asset.name, code: asset.code },
    requestId: req.requestId,
  });

  res.status(201).json(view(asset));
}

export async function listAssets(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.read");

  const clauses = ["company_id::text = $1"];
  const params = [principal.orgId];
  if (req.query.status) {
    params.push(req.query.status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(Number(req.query.limit ?? 100));
  const limitIdx = params.length;

  const { rows } = await pgQuery(
    `SELECT ${ASSET_COLS} FROM asset.assets
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${limitIdx}`,
    params,
  );
  res.json({ items: rows.map(view), next_cursor: null });
}

export async function getAsset(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.read");
  const asset = await loadAsset(principal.orgId, req.params.assetId);

  const { rows: history } = await pgQuery(
    `SELECT event_type, actor_id, note, created_at
       FROM asset.history WHERE asset_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 200`,
    [asset.id],
  );

  res.json({
    ...view(asset),
    history: history.map((h) => ({
      action: h.event_type,
      actor_id: h.actor_id ?? null,
      detail: h.note ?? "",
      created_at: h.created_at,
    })),
  });
}

export async function assetAction(req, res) {
  const principal = resolvePrincipal(req);
  const payload = actionSchema.parse(req.body);
  principal.require(
    payload.action === "loan" || payload.action === "return" ? "asset.read" : "asset.write",
  );

  const asset = await loadAsset(principal.orgId, req.params.assetId);
  if (payload.action === "loan" && asset.status !== AVAILABLE_STATUS) {
    throw new ApiError("CONFLICT", `asset is not available: ${asset.status}`);
  }

  const before = asset.status;
  const nextStatus = STATUS_BY_ACTION[payload.action];

  const updated = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE asset.assets
          SET status = $1, version = version + 1, updated_at = now()
        WHERE id = $2 AND company_id::text = $3
        RETURNING ${ASSET_COLS}`,
      [nextStatus, asset.id, principal.orgId],
    );
    await client.query(
      `INSERT INTO asset.history (asset_id, event_type, actor_id, note)
       VALUES ($1, $2, $3, $4)`,
      [asset.id, payload.action, String(principal.userId), payload.detail ?? ""],
    );
    return rows[0];
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: `asset.${payload.action}`,
    resourceType: "asset",
    resourceId: asset.id,
    actorId: principal.userId,
    before: { status: before },
    after: { status: updated.status },
    requestId: req.requestId,
  });

  if (["lost", "damaged", "dispose"].includes(payload.action)) {
    await safeNotify({
      tenantId: principal.tenantId,
      recipientId: updated.assignee_id ?? principal.userId,
      type: `asset.${payload.action}`,
      title: `자산 상태 변경: ${updated.name} (${updated.status})`,
      relatedType: "asset",
      relatedId: updated.id,
      dedupeKey: `asset:${payload.action}:${updated.id}`,
    });
  }

  res.json(view(updated));
}

export async function reserve(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("reservation.create");
  const payload = reservationSchema.parse(req.body);

  const assetId = payload.asset_id ?? payload.resource_id;
  const startsAt = payload.starts_at ?? payload.start_at;
  const endsAt = payload.ends_at ?? payload.end_at;
  if (assetId == null || !startsAt || !endsAt) {
    throw new ApiError("VALIDATION_ERROR", "asset_id, starts_at, ends_at are required");
  }
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new ApiError("VALIDATION_ERROR", "ends_at must be after starts_at");
  }

  // 자산이 같은 회사인지 검증.
  const asset = await loadAsset(principal.orgId, String(assetId));

  const reservation = await pgTransaction(async (client) => {
    const { rows: conflicts } = await client.query(
      `SELECT id FROM asset.reservations
        WHERE asset_id = $1
          AND status IN ('reserved', 'checked_out')
          AND starts_at < $3 AND ends_at > $2
        LIMIT 1`,
      [asset.id, startsAt, endsAt],
    );
    if (conflicts.length > 0) {
      throw new ApiError("CONFLICT", "asset already reserved for that time window");
    }
    const { rows } = await client.query(
      `INSERT INTO asset.reservations (asset_id, reserved_by, starts_at, ends_at, status, note)
       VALUES ($1, $2, $3, $4, 'reserved', $5)
       RETURNING id, asset_id, reserved_by, starts_at, ends_at, status, note`,
      [asset.id, String(principal.userId), startsAt, endsAt, payload.note ?? null],
    );
    return rows[0];
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: "reservation.created",
    resourceType: "reservation",
    resourceId: reservation.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.status(201).json({
    id: reservation.id,
    asset_id: reservation.asset_id,
    reserved_by: reservation.reserved_by,
    starts_at: reservation.starts_at,
    ends_at: reservation.ends_at,
    status: reservation.status,
    note: reservation.note ?? null,
  });
}

export async function listReservations(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.read");

  const { rows } = await pgQuery(
    `SELECT r.id, r.asset_id, r.reserved_by, r.starts_at, r.ends_at, r.status, r.note,
            a.name AS asset_name
       FROM asset.reservations r
       JOIN asset.assets a ON a.id = r.asset_id
      WHERE a.company_id::text = $1
      ORDER BY r.starts_at ASC
      LIMIT $2`,
    [principal.orgId, Number(req.query.limit ?? 100)],
  );

  res.json({
    items: rows.map((r) => ({
      id: r.id,
      asset_id: r.asset_id,
      asset_name: r.asset_name,
      reserved_by: r.reserved_by,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      status: r.status,
      note: r.note ?? null,
    })),
  });
}

export async function checkIn(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("reservation.create");
  const reservation = await loadReservation(principal.orgId, req.params.reservationId);

  // perp_db reservations CHECK: status ∈ {reserved, checked_out, returned, cancelled}.
  // 체크인(수령) 개념은 'checked_out' 으로 저장한다('checked_in' 은 DB 가 거부).
  const { rows } = await pgQuery(
    `UPDATE asset.reservations SET status = 'checked_out'
      WHERE id = $1 RETURNING id, status`,
    [reservation.id],
  );
  res.json({ id: rows[0].id, status: rows[0].status });
}

export async function cancelReservation(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("reservation.create");
  const reservation = await loadReservation(principal.orgId, req.params.reservationId);

  const { rows } = await pgQuery(
    `UPDATE asset.reservations SET status = 'cancelled'
      WHERE id = $1 RETURNING id, status`,
    [reservation.id],
  );
  res.json({ id: rows[0].id, status: rows[0].status });
}
