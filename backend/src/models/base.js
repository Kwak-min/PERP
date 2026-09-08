import crypto from "node:crypto";

import { db } from "../config/db.js";
import { notFound } from "../utils/errors.js";
import { signalWikiWrite } from "../config/knowledge-wake.js";

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

const COMMON_COLUMNS = [
  "id",
  "tenant_id",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "version",
  "deleted_at",
];

function columnsOf(table) {
  return db()
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

const columnCache = new Map();

function columns(table) {
  if (!columnCache.has(table)) columnCache.set(table, columnsOf(table));
  return columnCache.get(table);
}

export function hasColumn(table, name) {
  return columns(table).includes(name);
}

function scopeClause(table, principal, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const where = [`${prefix}tenant_id = ?`];
  const params = [principal.tenantId];
  if (hasColumn(table, "org_id")) {
    where.push(`${prefix}org_id = ?`);
    params.push(principal.orgId);
  }
  if (hasColumn(table, "deleted_at")) {
    where.push(`${prefix}deleted_at IS NULL`);
  }
  return { where, params };
}

export function listScoped(table, principal, filters = [], options = {}) {
  const { where, params } = scopeClause(table, principal);
  for (const filter of filters) {
    where.push(filter.sql);
    params.push(...(filter.params ?? []));
  }
  const orderBy = options.orderBy ?? "created_at DESC";
  const limit = Number(options.limit ?? 100);
  return db()
    .prepare(`SELECT * FROM ${table} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`)
    .all(...params, limit);
}

export function findScoped(table, principal, id) {
  const { where, params } = scopeClause(table, principal);
  return (
    db()
      .prepare(`SELECT * FROM ${table} WHERE ${where.join(" AND ")} AND id = ?`)
      .get(...params, id) ?? null
  );
}

export function getScoped(table, principal, id, label = null) {
  const row = findScoped(table, principal, id);
  if (!row) throw notFound(label ?? table);
  return row;
}

export function countScoped(table, principal, filters = []) {
  const { where, params } = scopeClause(table, principal);
  for (const filter of filters) {
    where.push(filter.sql);
    params.push(...(filter.params ?? []));
  }
  return db()
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where.join(" AND ")}`)
    .get(...params).c;
}

export function insert(table, values) {
  const now = nowIso();
  const record = { ...values };
  if (hasColumn(table, "id") && !record.id) record.id = newId();
  if (hasColumn(table, "created_at") && !record.created_at) record.created_at = now;
  if (hasColumn(table, "updated_at") && !record.updated_at) record.updated_at = now;
  if (hasColumn(table, "version") && record.version === undefined) record.version = 1;

  const allowed = columns(table);
  const keys = Object.keys(record).filter((k) => allowed.includes(k));
  const placeholders = keys.map(() => "?").join(", ");
  const params = keys.map((k) => normalize(record[k]));
  db()
    .prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`)
    .run(...params);
  return db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(record.id);
}

export function update(table, id, patch, actorId = null) {
  const allowed = columns(table);
  const record = { ...patch };
  if (allowed.includes("updated_at")) record.updated_at = nowIso();
  if (allowed.includes("updated_by") && actorId) record.updated_by = actorId;

  const keys = Object.keys(record).filter((k) => allowed.includes(k) && k !== "id");
  if (keys.length === 0) return db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  const assignments = keys.map((k) => `${k} = ?`).join(", ");
  const params = keys.map((k) => normalize(record[k]));
  db().prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...params, id);
  signalWikiWrite();
  return db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

export function bumpVersion(table, row, patch, actorId = null) {
  return update(table, row.id, { ...patch, version: (row.version ?? 1) + 1 }, actorId);
}

export function softDelete(table, id, actorId = null) {
  return update(table, id, { deleted_at: nowIso() }, actorId);
}

export function hardDelete(table, whereSql, params = []) {
  const result = db().prepare(`DELETE FROM ${table} WHERE ${whereSql}`).run(...params);
  signalWikiWrite();
  return result;
}

/** node:sqlite 는 boolean/undefined 바인딩을 거부하므로 정규화한다. */
function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

export { COMMON_COLUMNS, normalize };
