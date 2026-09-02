import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { bumpVersion, getScoped, insert, listScoped, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { notify } from "../services/notification.service.js";
import { ApiError } from "../utils/errors.js";

const assetSchema = z.object({
  asset_no: z.string().min(1),
  name: z.string().min(1),
  category: z.string().default("equipment"),
  quantity: z.number().int().default(1),
  threshold: z.number().int().default(0),
  location: z.string().nullable().optional(),
  custodian_id: z.string().nullable().optional(),
});

const actionSchema = z.object({
  action: z.enum(["loan", "return", "inspect", "repair", "lost", "damaged", "dispose"]),
  detail: z.string().default(""),
});

const reservationSchema = z.object({
  resource_type: z.enum(["asset", "space"]).default("asset"),
  resource_id: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  event_id: z.string().nullable().optional(),
});

const STATUS_BY_ACTION = {
  loan: "loaned",
  return: "available",
  inspect: "available",
  repair: "repairing",
  lost: "lost",
  damaged: "damaged",
  dispose: "disposed",
};

const view = (a) => ({
  id: a.id,
  asset_no: a.asset_no,
  name: a.name,
  category: a.category,
  quantity: a.quantity,
  threshold: a.threshold,
  status: a.status,
  location: a.location,
  custodian_id: a.custodian_id,
  qr_code: a.qr_code,
  low_stock: a.quantity <= a.threshold,
  version: a.version,
});

export function createAsset(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.write");
  const payload = assetSchema.parse(req.body);

  const asset = insert("asset", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    asset_no: payload.asset_no,
    name: payload.name,
    category: payload.category,
    quantity: payload.quantity,
    threshold: payload.threshold,
    location: payload.location ?? null,
    custodian_id: payload.custodian_id ?? null,
    qr_code: `orbitflow://asset/${payload.asset_no}`,
    created_by: principal.userId,
  });

  insert("asset_history", {
    tenant_id: principal.tenantId,
    asset_id: asset.id,
    action: "registered",
    actor_id: principal.userId,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "asset.created",
    resourceType: "asset",
    resourceId: asset.id,
    actorId: principal.userId,
    after: { asset_no: asset.asset_no },
    requestId: req.requestId,
  });

  res.status(201).json(view(asset));
}

export function listAssets(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.read");
  const filters = [];
  if (req.query.status) filters.push({ sql: "status = ?", params: [req.query.status] });
  if (req.query.custodian_id) filters.push({ sql: "custodian_id = ?", params: [req.query.custodian_id] });
  const rows = listScoped("asset", principal, filters, { limit: Number(req.query.limit ?? 100) });
  res.json({ items: rows.map(view), next_cursor: null });
}

export function getAsset(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.read");
  const asset = getScoped("asset", principal, req.params.assetId, "asset");
  const history = listScoped(
    "asset_history",
    principal,
    [{ sql: "asset_id = ?", params: [asset.id] }],
    { limit: 200 },
  );
  res.json({
    ...view(asset),
    history: history.map((h) => ({
      action: h.action,
      actor_id: h.actor_id,
      detail: h.detail,
      created_at: h.created_at,
    })),
  });
}

export function assetAction(req, res) {
  const principal = resolvePrincipal(req);
  const payload = actionSchema.parse(req.body);
  principal.require(
    payload.action === "loan" || payload.action === "return" ? "asset.read" : "asset.write",
  );

  const asset = getScoped("asset", principal, req.params.assetId, "asset");
  if (payload.action === "loan" && asset.status !== "available") {
    throw new ApiError("CONFLICT", `asset is not available: ${asset.status}`);
  }

  const before = asset.status;
  const updated = bumpVersion(
    "asset",
    asset,
    { status: STATUS_BY_ACTION[payload.action] },
    principal.userId,
  );

  insert("asset_history", {
    tenant_id: principal.tenantId,
    asset_id: asset.id,
    action: payload.action,
    actor_id: principal.userId,
    detail: payload.detail,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: `asset.${payload.action}`,
    resourceType: "asset",
    resourceId: asset.id,
    actorId: principal.userId,
    before: { status: before },
    after: { status: updated.status },
    requestId: req.requestId,
  });

  if (updated.quantity <= updated.threshold) {
    notify({
      tenantId: principal.tenantId,
      recipientId: updated.custodian_id ?? principal.userId,
      type: "asset.low_stock",
      title: `재고 임계치 도달: ${updated.name}`,
      relatedType: "asset",
      relatedId: updated.id,
      dedupeKey: `lowstock:${updated.id}`,
    });
  }

  res.json(view(updated));
}

export function reserve(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("reservation.create");
  const payload = reservationSchema.parse(req.body);

  if (payload.end_at <= payload.start_at) {
    throw new ApiError("VALIDATION_ERROR", "end_at must be after start_at");
  }

  const overlap = listScoped(
    "reservation",
    principal,
    [
      { sql: "resource_id = ?", params: [payload.resource_id] },
      { sql: "status = ?", params: ["confirmed"] },
      { sql: "start_at < ?", params: [payload.end_at] },
      { sql: "end_at > ?", params: [payload.start_at] },
    ],
    { limit: 1 },
  )[0];
  if (overlap) {
    throw new ApiError("CONFLICT", "resource already reserved for that time window");
  }

  const reservation = insert("reservation", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    resource_type: payload.resource_type,
    resource_id: payload.resource_id,
    requester_id: principal.userId,
    event_id: payload.event_id ?? null,
    start_at: payload.start_at,
    end_at: payload.end_at,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "reservation.created",
    resourceType: "reservation",
    resourceId: reservation.id,
    actorId: principal.userId,
    requestId: req.requestId,
  });

  res.status(201).json({
    id: reservation.id,
    resource_id: reservation.resource_id,
    start_at: reservation.start_at,
    end_at: reservation.end_at,
    status: reservation.status,
  });
}

export function listReservations(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("asset.read");
  const rows = listScoped("reservation", principal, [], {
    limit: Number(req.query.limit ?? 100),
    orderBy: "start_at ASC",
  });
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      requester_id: r.requester_id,
      start_at: r.start_at,
      end_at: r.end_at,
      status: r.status,
      checked_in_at: r.checked_in_at,
    })),
  });
}

export function checkIn(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("reservation.create");
  const reservation = getScoped("reservation", principal, req.params.reservationId, "reservation");
  const updated = update(
    "reservation",
    reservation.id,
    { checked_in_at: new Date().toISOString() },
    principal.userId,
  );
  res.json({ id: updated.id, checked_in_at: updated.checked_in_at });
}

export function cancelReservation(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("reservation.create");
  const reservation = getScoped("reservation", principal, req.params.reservationId, "reservation");
  const updated = update("reservation", reservation.id, { status: "cancelled" }, principal.userId);
  res.json({ id: updated.id, status: updated.status });
}
