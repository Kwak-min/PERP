import { pgQuery, pgTransaction } from '../config/pg.js';
import { ApiError, notFound } from '../utils/errors.js';
import { effectivePgPermissions } from '../config/menu-permissions.js';
import { canReadPgApproval } from './pg-approval-read-policy.service.js';
import { assertFeatureEnabled } from '../config/features.js';
import { assertReceiptBounds, newReceiptStage, receiptUploadView, removeStagedReceipt, tokenHash, writeReceipt, receiptTokensSchema } from './receipt-files.service.js';

export async function stagePgReceipt(principal, kind, validated) {
  const stage = newReceiptStage(validated);
  const { rows: [saved] } = await pgTransaction(async client => {
    await freshPgReceiptPrincipal(client, principal, kind);
    return client.query(`INSERT INTO files.receipt_uploads(id,token_hash,source,company_id,actor_id,kind,storage_key,filename,mime,extension,size_bytes,checksum_sha256,state)
      VALUES($1,$2,'perp_db',$3,$4,$5,$6,$7,$8,$9,$10,$11,'writing') RETURNING expires_at`, [stage.id, stage.token_hash, principal.companyId, principal.userId, kind,
      stage.storage_key, stage.filename, stage.mime, stage.extension, stage.size_bytes, stage.checksum_sha256]);
  });
  try {
    await pgTransaction(async client => {
      const { rows: [claim] } = await client.query('SELECT state,expires_at FROM files.receipt_uploads WHERE id=$1 FOR UPDATE', [stage.id]);
      const { rows: [clock] } = await client.query('SELECT clock_timestamp() AS now');
      if (!claim || claim.state !== 'writing' || claim.expires_at <= clock.now) throw notFound('receipt upload');
      writeReceipt(stage);
      await client.query("UPDATE files.receipt_uploads SET state='ready' WHERE id=$1", [stage.id]);
    });
  } catch (error) {
    await pgQuery('UPDATE files.receipt_uploads SET cleanup_error=$1 WHERE id=$2', ['UPLOAD_WRITE_FAILED', stage.id]);
    throw error;
  }
  return receiptUploadView(stage, saved.expires_at);
}

export async function pgReceiptParent(client, principal, { kind, parentId, write = false }) {
  if (!/^[1-9]\d*$/.test(String(parentId))) throw notFound('receipt parent');
  const table = kind === 'transaction' ? 'accounting.journal_entries' : 'org.approval_requests';
  const { rows: [parent] } = await client.query(`SELECT *,xmin::text AS receipt_version FROM ${table} WHERE id=$1 AND company_id=$2 ${write ? 'FOR UPDATE' : ''}`, [parentId, principal.companyId]);
  if (!parent) throw notFound('receipt parent');
  if (kind === 'approval') {
    const requester = String(parent.requester_id) === String(principal.userId);
    if (write) {
      principal.require('approval.request');
      if (!requester) throw notFound('receipt parent');
      if (!['draft', 'pending'].includes(parent.status) || parent.workflow_locked) throw new ApiError('CONFLICT', '제출 snapshot의 결재 원증빙은 변경할 수 없습니다.');
    } else if (!canReadPgApproval(principal, parent)) throw notFound('receipt parent');
  } else principal.require(`transaction.${write ? 'write' : 'read'}`);
  return parent;
}

export async function freshPgReceiptPrincipal(client, principal, kind, read = false) {
  await client.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [principal.companyId]);
  const permission = kind === 'transaction' ? `transaction.${read ? 'read' : 'write'}` : null;
  const { rows: [membership] } = await client.query(`SELECT m.user_id FROM org.company_memberships m JOIN auth.users u ON u.id=m.user_id
    JOIN org.companies c ON c.id=m.company_id WHERE m.user_id=$1 AND m.company_id=$2 AND m.status='active' AND u.account_status='active'
    AND u.approval_status='approved' AND c.is_active FOR SHARE OF m,u`, [principal.userId, principal.companyId]);
  const { rows: grants } = await client.query(`SELECT p.code,r.name AS role FROM org.user_roles ur JOIN org.roles r ON r.id=ur.role_id AND r.company_id=$2
    JOIN org.role_permissions rp ON rp.role_id=r.id JOIN org.permissions p ON p.id=rp.permission_id WHERE ur.user_id=$1 AND ur.workspace_id IS NULL`, [principal.userId, principal.companyId]);
  if (!membership) throw new ApiError('PERMISSION_DENIED', '현재 원증빙 첨부 권한이 없습니다.');
  const permissions = effectivePgPermissions(grants);
  if ((permission && !permissions.includes(permission)) || (kind === 'approval' && !permissions.some(code => code === 'approval.request' || (read && code === 'approval.decide')))) {
    throw new ApiError('PERMISSION_DENIED', '현재 원증빙 첨부 권한이 없습니다.');
  }
  const fresh = { ...principal, has: code => permissions.includes(code), require(code) { if (!this.has(code)) throw new ApiError('PERMISSION_DENIED', '현재 원증빙 권한이 없습니다.'); } };
  fresh.require(kind === 'transaction' ? 'menu.finance' : 'menu.approvals');
  const { rows: modules } = await client.query('SELECT module_key FROM org.company_modules WHERE company_id=$1', [principal.companyId]);
  if (kind === 'approval') {
    const { rows: [features] } = await client.query('SELECT enabled_features FROM org.company_feature_settings WHERE company_id=$1', [principal.companyId]);
    assertFeatureEnabled('approvals', features?.enabled_features, modules.map(row => row.module_key));
  } else if (!modules.some(row => row.module_key === 'finance')) throw new ApiError('MODULE_DISABLED', '재무 모듈이 비활성화되어 있습니다.');
  return fresh;
}

// 회사 lock -> 현재 권한 -> parent lock -> 정렬된 upload lock. 호출자가 BEGIN/COMMIT/ROLLBACK을 소유한다.
// expectedVersion은 같은 transaction에서 읽은 xmin::text이며 임의 기본값을 넣지 않는다.
export async function consumePgReceipts(client, principal, { kind, parentId, expectedVersion, tokens }) {
  const parsed = receiptTokensSchema.parse(tokens);
  const fresh = await freshPgReceiptPrincipal(client, principal, kind);
  const parent = await pgReceiptParent(client, fresh, { kind, parentId, write: true });
  if (expectedVersion !== parent.receipt_version) throw new ApiError('VERSION_CONFLICT', '부모 기록의 버전이 변경되었습니다.');
  const { rows } = await client.query(`SELECT * FROM files.receipt_uploads WHERE token_hash=ANY($1::text[]) AND source='perp_db' AND company_id=$2 AND actor_id=$3 AND kind=$4
    ORDER BY id FOR UPDATE`, [parsed.map(tokenHash), principal.companyId, principal.userId, kind]);
  const { rows: [clock] } = await client.query('SELECT clock_timestamp() AS now');
  if (rows.length !== parsed.length || rows.some(row => row.state !== 'ready' || row.expires_at <= clock.now)) throw notFound('receipt upload');
  const table = kind === 'transaction' ? 'accounting.journal_entry_files' : 'org.approval_request_files', parentColumn = kind === 'transaction' ? 'entry_id' : 'approval_id';
  const { rows: [existing] } = await client.query(`SELECT COUNT(*)::int AS count,COALESCE(SUM(f.size_bytes),0)::text AS bytes FROM ${table} l JOIN files.objects f ON f.id=l.file_id WHERE l.${parentColumn}=$1 AND l.company_id=$2`, [parentId, principal.companyId]);
  assertReceiptBounds({ count: existing.count, bytes: Number(existing.bytes) }, rows);
  const result = [];
  for (const row of rows) {
    const { rows: [file] } = await client.query(`INSERT INTO files.objects(company_id,uploader_id,original_name,extension,mime_type,size_bytes,checksum_sha256,storage_bucket,storage_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,'orbitflow-local',$8) RETURNING id`, [principal.companyId, principal.userId, row.filename, row.extension, row.mime, row.size_bytes, row.checksum_sha256, row.storage_key]);
    await client.query(`INSERT INTO ${table}(company_id,${parentColumn},file_id,receipt_upload_id,created_by) VALUES($1,$2,$3,$4,$5)`, [principal.companyId, parentId, file.id, row.id, principal.userId]);
    await client.query("UPDATE files.receipt_uploads SET state='consumed',consumed_file_id=$1 WHERE id=$2", [file.id, row.id]);
    await client.query('INSERT INTO files.receipt_events(company_id,kind,parent_id,file_id,actor_id,checksum_sha256) VALUES($1,$2,$3,$4,$5,$6)', [principal.companyId, kind, parentId, file.id, principal.userId, row.checksum_sha256]);
    result.push({ file_id: file.id, filename: row.filename, mime: row.mime, size_bytes: Number(row.size_bytes), checksum_sha256: row.checksum_sha256 });
  }
  return result;
}

export async function getPgReceipt(principal, { kind, parentId, fileId }) {
  return pgTransaction(async client => {
    const fresh = await freshPgReceiptPrincipal(client, principal, kind, true);
    await pgReceiptParent(client, fresh, { kind, parentId });
    if (!/^[1-9]\d*$/.test(String(fileId))) throw notFound('receipt');
    const table = kind === 'transaction' ? 'accounting.journal_entry_files' : 'org.approval_request_files', parentColumn = kind === 'transaction' ? 'entry_id' : 'approval_id';
    const { rows: [file] } = await client.query(`SELECT f.storage_key,f.original_name AS filename,f.mime_type AS mime,f.size_bytes,f.checksum_sha256 FROM ${table} l
      JOIN files.objects f ON f.id=l.file_id AND f.company_id=l.company_id AND f.storage_bucket='orbitflow-local'
      JOIN files.receipt_uploads u ON u.id=l.receipt_upload_id AND u.consumed_file_id=f.id AND u.state='consumed'
      WHERE l.${parentColumn}=$1 AND l.file_id=$2 AND l.company_id=$3`, [parentId, fileId, principal.companyId]);
    if (!file) throw notFound('receipt');
    return file;
  });
}

export async function cleanupPgReceipts() {
  return pgTransaction(async client => {
    const result = { deleted: 0, failed: 0, shared: 0 };
    const { rows } = await client.query("SELECT * FROM files.receipt_uploads WHERE state IN ('writing','ready') AND expires_at<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED");
    for (const row of rows) {
      const { rowCount } = await client.query("SELECT 1 FROM files.objects WHERE storage_bucket='orbitflow-local' AND storage_key=$1", [row.storage_key]);
      if (rowCount) {
        await client.query('UPDATE files.receipt_uploads SET cleanup_error=$1 WHERE id=$2', ['SHARED_OBJECT_PRESERVED', row.id]); result.shared++; continue;
      }
      try { removeStagedReceipt(row); }
      catch (error) {
        await client.query('UPDATE files.receipt_uploads SET cleanup_error=$1 WHERE id=$2', [`UNLINK_FAILED:${error.code ?? 'UNKNOWN'}`, row.id]); result.failed++; continue;
      }
      await client.query("UPDATE files.receipt_uploads SET state='deleted',cleanup_error=NULL WHERE id=$1", [row.id]); result.deleted++;
    }
    return result;
  });
}
