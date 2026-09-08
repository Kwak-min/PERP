import { db, transaction } from '../config/db.js';
import { getScoped, insert } from '../models/base.js';
import * as audit from './audit.service.js';
import { ApiError, notFound } from '../utils/errors.js';
import { legacyRoleGrants } from './company-roles.service.js';
import { assertFeatureEnabled } from '../config/features.js';
import { assertReceiptBounds, newReceiptStage, receiptUploadView, removeStagedReceipt, tokenHash, writeReceipt, receiptTokensSchema, RECEIPT_LIMITS } from './receipt-files.service.js';

export function freshReceiptPrincipal(principal, kind) {
  const member = db().prepare(`SELECT m.roles,o.modules,o.enabled_features FROM membership m
    JOIN app_user u ON u.id=m.user_id JOIN organization o ON o.id=m.org_id AND o.tenant_id=m.tenant_id JOIN tenant t ON t.id=o.tenant_id
    WHERE m.user_id=? AND m.org_id=? AND m.tenant_id=? AND m.status='active' AND m.deleted_at IS NULL
      AND u.auth_status='active' AND o.deleted_at IS NULL AND t.status='active'`).get(principal.userId, principal.orgId, principal.tenantId);
  if (!member) throw new ApiError('PERMISSION_DENIED', '현재 회사 소속이 없습니다.');
  const grants = legacyRoleGrants(principal, member.roles.split(',').filter(Boolean));
  const fresh = { ...principal, scope: grants.scope, has: code => grants.permissions.has('*') || grants.permissions.has(code),
    require(code) { if (!this.has(code)) throw new ApiError('PERMISSION_DENIED', '현재 원증빙 권한이 없습니다.'); } };
  fresh.require(kind === 'transaction' ? 'menu.finance' : 'menu.approvals');
  if (kind === 'approval') assertFeatureEnabled('approvals', member.enabled_features, member.modules);
  else if (!member.modules.split(',').includes('finance')) throw new ApiError('MODULE_DISABLED', '재무 모듈이 비활성화되어 있습니다.');
  return fresh;
}

export function stageLegacyReceipt(principal, kind, validated) {
  freshReceiptPrincipal(principal, kind).require(kind === 'transaction' ? 'transaction.write' : 'approval.request');
  const stage = newReceiptStage(validated), now = new Date(), expires = new Date(now.getTime() + RECEIPT_LIMITS.lifetimeMs).toISOString();
  db().prepare(`INSERT INTO receipt_upload(id,token_hash,source,tenant_id,org_id,actor_id,kind,storage_key,filename,mime,extension,size_bytes,checksum_sha256,state,created_at,expires_at)
    VALUES(?,?,'legacy',?,?,?,?,?,?,?,?,?,?,'writing',?,?)`).run(stage.id, stage.token_hash, principal.tenantId, principal.orgId, principal.userId, kind,
    stage.storage_key, stage.filename, stage.mime, stage.extension, stage.size_bytes, stage.checksum_sha256, now.toISOString(), expires);
  try {
    transaction(() => {
      const claim = db().prepare("UPDATE receipt_upload SET state=state WHERE id=? AND state='writing' AND expires_at>?").run(stage.id, new Date().toISOString());
      if (claim.changes !== 1) throw notFound('receipt upload');
      writeReceipt(stage);
      db().prepare("UPDATE receipt_upload SET state='ready' WHERE id=?").run(stage.id);
    })();
  } catch (error) {
    db().prepare('UPDATE receipt_upload SET cleanup_error=? WHERE id=?').run('UPLOAD_WRITE_FAILED', stage.id);
    throw error;
  }
  return receiptUploadView(stage, expires);
}

export function legacyReceiptParent(principal, { kind, parentId, write = false }) {
  if (kind === 'transaction') principal.require(`transaction.${write ? 'write' : 'read'}`);
  const parent = getScoped(kind === 'transaction' ? 'transaction_record' : 'approval', principal, parentId);
  if (kind === 'approval') {
    const requester = parent.requester_id === principal.userId;
    const assigned = db().prepare('SELECT 1 FROM approval_step WHERE tenant_id=? AND approval_id=? AND approver_id=? AND deleted_at IS NULL')
      .get(principal.tenantId, parentId, principal.userId);
    if (write) {
      principal.require('approval.request');
      if (!requester) throw notFound('receipt parent');
      if (!['draft', 'pending'].includes(parent.status) || parent.workflow_locked) {
        throw new ApiError('CONFLICT', '제출 snapshot의 결재 원증빙은 변경할 수 없습니다.');
      }
    } else if (parent.status === 'draft') {
      if (!requester || !principal.has('approval.request')) throw notFound('receipt parent');
    } else if (requester) principal.require('approval.request');
    else if (!assigned || !principal.has('approval.decide')) throw notFound('receipt parent');
  } else if (principal.scope !== 'all' && parent.created_by !== principal.userId) {
    throw notFound('receipt parent');
  }
  return parent;
}

// 호출자는 BEGIN IMMEDIATE 또는 기존 동기 transaction 안에서 부모 쓰기와 함께 호출한다.
// expectedVersion은 같은 transaction에서 읽은 실제 parent.version. 본문에서 file ID/key를 받지 않는다.
export function consumeLegacyReceipts(principal, { kind, parentId, expectedVersion, tokens }) {
  if (!db().isTransaction) throw new Error('consumeLegacyReceipts requires a caller-owned synchronous transaction');
  const parsed = receiptTokensSchema.parse(tokens);
  const parent = legacyReceiptParent(freshReceiptPrincipal(principal, kind), { kind, parentId, write: true });
  if (expectedVersion !== parent.version) throw new ApiError('VERSION_CONFLICT', '부모 기록의 버전이 변경되었습니다.');
  const rows = parsed.map(token => db().prepare(`SELECT * FROM receipt_upload WHERE token_hash=? AND source='legacy' AND tenant_id=? AND org_id=? AND actor_id=? AND kind=?
    AND state='ready' AND expires_at>?`).get(tokenHash(token), principal.tenantId, principal.orgId, principal.userId, kind, new Date().toISOString()));
  if (rows.some(row => !row)) throw notFound('receipt upload');
  const table = kind === 'transaction' ? 'transaction_evidence' : 'approval_receipt_files', parentColumn = kind === 'transaction' ? 'transaction_id' : 'approval_id';
  // 과거 link.org_id는 NULL이다. 인가된 부모와 같은 tenant/company의 원본만 합산하며 기존 행은 변경하지 않는다.
  const existing = db().prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(f.size),0) AS bytes FROM ${table} l
    JOIN file_object f ON f.id=l.file_id AND f.tenant_id=l.tenant_id
    WHERE l.${parentColumn}=? AND l.tenant_id=? AND f.org_id=? AND (l.org_id IS NULL OR l.org_id=f.org_id)`)
    .get(parent.id, parent.tenant_id, parent.org_id);
  assertReceiptBounds(existing, rows);
  return rows.map(row => {
    const file = insert('file_object', { tenant_id: principal.tenantId, org_id: principal.orgId, storage_key: row.storage_key,
      filename: row.filename, mime: row.mime, size: row.size_bytes, checksum: row.checksum_sha256,
      related_type: kind, related_id: parentId, created_by: principal.userId });
    const link = { tenant_id: principal.tenantId, org_id: principal.orgId, file_id: file.id, receipt_upload_id: row.id, created_by: principal.userId };
    if (kind === 'transaction') insert(table, { ...link, transaction_id: parentId });
    else db().prepare(`INSERT INTO approval_receipt_files(approval_id,file_id,tenant_id,org_id,receipt_upload_id,created_by,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(parentId, file.id, principal.tenantId, principal.orgId, row.id, principal.userId, new Date().toISOString());
    db().prepare("UPDATE receipt_upload SET state='consumed',consumed_file_id=? WHERE id=?").run(file.id, row.id);
    audit.record({ tenantId: principal.tenantId, orgId: principal.orgId, actorId: principal.userId, action: 'receipt.attached', resourceType: kind,
      resourceId: parentId, after: { file_id: file.id, checksum_sha256: row.checksum_sha256 } });
    return { file_id: file.id, filename: row.filename, mime: row.mime, size_bytes: row.size_bytes, checksum_sha256: row.checksum_sha256 };
  });
}

export function getLegacyReceipt(principal, { kind, parentId, fileId }) {
  legacyReceiptParent(principal, { kind, parentId });
  const table = kind === 'transaction' ? 'transaction_evidence' : 'approval_receipt_files', parentColumn = kind === 'transaction' ? 'transaction_id' : 'approval_id';
  const row = db().prepare(`SELECT f.storage_key,f.filename,f.mime,f.size AS size_bytes,f.checksum AS checksum_sha256 FROM ${table} l
    JOIN file_object f ON f.id=l.file_id AND f.tenant_id=l.tenant_id AND f.org_id=l.org_id
    JOIN receipt_upload u ON u.id=l.receipt_upload_id AND u.consumed_file_id=f.id AND u.state='consumed'
    WHERE l.${parentColumn}=? AND l.file_id=? AND l.tenant_id=? AND l.org_id=? AND f.deleted_at IS NULL`).get(parentId, fileId, principal.tenantId, principal.orgId);
  if (!row) throw notFound('receipt');
  return row;
}

// 미소비 staging만 검사한다. 공유 file_object 경로는 보존하며 재시도 사유를 남긴다.
export function cleanupLegacyReceipts() {
  const result = { deleted: 0, failed: 0, shared: 0 };
  db().exec('BEGIN IMMEDIATE');
  try {
    const rows = db().prepare("SELECT * FROM receipt_upload WHERE state IN ('writing','ready') AND expires_at<=?").all(new Date().toISOString());
    for (const row of rows) {
      if (db().prepare('SELECT 1 FROM file_object WHERE storage_key=?').get(row.storage_key)) {
        db().prepare('UPDATE receipt_upload SET cleanup_error=? WHERE id=?').run('SHARED_OBJECT_PRESERVED', row.id); result.shared++; continue;
      }
      try { removeStagedReceipt(row); }
      catch (error) {
        db().prepare('UPDATE receipt_upload SET cleanup_error=? WHERE id=?').run(`UNLINK_FAILED:${error.code ?? 'UNKNOWN'}`, row.id); result.failed++; continue;
      }
      db().prepare("UPDATE receipt_upload SET state='deleted',cleanup_error=NULL WHERE id=?").run(row.id); result.deleted++;
    }
    db().exec('COMMIT');
  } catch (error) { db().exec('ROLLBACK'); throw error; }
  return result;
}
