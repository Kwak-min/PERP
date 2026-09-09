import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../config/db.js';
import { pgTransaction } from '../config/pg.js';
import { ApiError, notFound } from '../utils/errors.js';
import { parseExpenseCsv } from './expense-csv.service.js';
import { requestKeySchema } from './expense-input.service.js';
import { withLegacyFinanceTransaction, replayLegacyMutation, writeLegacyTransaction } from './legacy-expenses.service.js';
import { withPgFinanceTransaction, postPgTransaction } from './pg-expenses.service.js';
import { replayPgMutation, recordEvent } from './pg-finance.service.js';
import * as audit from './audit.service.js';
import { previewSchema, makeSnapshot, markIdentities, snapshotState, auditSnapshot, jobView, rowPage, assertReady, assertIdentity, importResult, importAudit } from './expense-import-snapshot.js';

const id = value => z.string().uuid().parse(value);
const legacyScope = p => [p.tenantId, p.orgId, p.userId];
const pgScope = p => [p.companyId, p.userId];
const clock = () => new Date().toISOString();
const uploadView = (upload, parsed) => ({ upload_id: upload.id, source: upload.source, expires_at: upload.expires_at,
  raw_sha256: parsed.rawSha256, parser_version: parsed.parserVersion, logical_record_count: parsed.logicalRecordCount,
  headers: parsed.headers, mapping_issues: parsed.mappingIssues });
const decodeLegacyJob = job => ({ ...job, snapshot: JSON.parse(job.content_active ? job.snapshot : job.audit_snapshot), result: job.result ? JSON.parse(job.result) : null,
  result_rows: job.result_rows ? JSON.parse(job.result_rows) : null });
function legacyJob(principal, jobId) {
  const job = db().prepare(`SELECT j.*, EXISTS(SELECT 1 FROM expense_import_uploads u
    WHERE u.id=j.upload_id AND julianday(u.expires_at)>julianday('now')) AS content_active
    FROM expense_import_jobs j WHERE tenant_id=? AND org_id=? AND actor_id=? AND id=?`).get(...legacyScope(principal), id(jobId));
  if (!job) throw notFound('import job');
  return decodeLegacyJob(job);
}
async function pgJob(client, principal, jobId) {
  const { rows: [job] } = await client.query(`SELECT j.*, EXISTS(SELECT 1 FROM accounting.expense_import_uploads u
    WHERE u.id=j.upload_id AND u.expires_at>clock_timestamp()) AS content_active
    FROM accounting.expense_import_jobs j WHERE company_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE`, [...pgScope(principal), id(jobId)]);
  if (!job) throw notFound('import job');
  if (!job.content_active) job.snapshot = job.audit_snapshot;
  return job;
}
function legacyAccounts(principal) {
  return db().prepare("SELECT id FROM account WHERE tenant_id=? AND org_id=? AND active=1 AND kind='expense' AND deleted_at IS NULL").all(principal.tenantId, principal.orgId);
}
async function pgAccounts(client, principal) {
  return (await client.query("SELECT id FROM accounting.accounts WHERE company_id=$1 AND is_active=true AND account_type='expense' FOR SHARE", [principal.companyId])).rows;
}
function assertAccounts(job, accounts) {
  const active = new Set(accounts.map(row => String(row.id)));
  const references = job.snapshot.content_expired ? job.snapshot.account_references
    : job.snapshot.rows.filter(row => row.disposition !== 'excluded' && row.payload)
      .map(row => ({ logicalRecordOrdinal: row.logicalRecordOrdinal, account_id: row.payload.account_id }));
  const changed = references.find(row => !active.has(row.account_id));
  if (changed) throw new ApiError('CONFLICT', '계정이 변경되었습니다. 새 미리보기를 만드세요.', { reason: 'IMPORT_ACCOUNT_CHANGED', job_id: job.id, logicalRecordOrdinal: changed.logicalRecordOrdinal });
}
function legacyIdentities(principal, rows) {
  const query = db().prepare('SELECT * FROM imported_transaction_identities WHERE tenant_id=? AND org_id=? AND identity_key=?');
  return rows.map(row => query.get(principal.tenantId, principal.orgId, row.identity_key)).filter(Boolean);
}
async function pgIdentities(client, principal, rows) {
  return (await client.query('SELECT * FROM accounting.imported_transaction_identities WHERE company_id=$1 AND identity_key=ANY($2::text[]) ORDER BY identity_key FOR UPDATE', [principal.companyId, rows.map(row => row.identity_key)])).rows;
}

export function stageLegacyExpenseImport(req, raw) {
  const parsed = parseExpenseCsv(raw);
  return withLegacyFinanceTransaction(req, principal => {
    principal.require('transaction.confirm');
    const upload = { id: randomUUID(), source: 'legacy', expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
    db().prepare('INSERT INTO expense_import_uploads(id,tenant_id,org_id,actor_id,raw,raw_sha256,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(upload.id, ...legacyScope(principal), raw, parsed.rawSha256, clock(), upload.expires_at);
    return uploadView(upload, parsed);
  });
}
export function stagePgExpenseImport(req, raw) {
  const parsed = parseExpenseCsv(raw);
  return withPgFinanceTransaction(req, async (client, principal) => {
    const { rows: [upload] } = await client.query('INSERT INTO accounting.expense_import_uploads(id,company_id,actor_id,raw,raw_sha256) VALUES($1,$2,$3,$4,$5) RETURNING id,source,expires_at', [randomUUID(), ...pgScope(principal), raw, parsed.rawSha256]);
    return uploadView(upload, parsed);
  });
}
export function previewLegacyExpenseImport(req) {
  const input = previewSchema.parse(req.body);
  return withLegacyFinanceTransaction(req, principal => {
    principal.require('transaction.confirm');
    const upload = db().prepare('SELECT raw FROM expense_import_uploads WHERE tenant_id=? AND org_id=? AND actor_id=? AND id=? AND expires_at>?')
      .get(...legacyScope(principal), input.upload_id, clock());
    if (!upload) throw notFound('import upload');
    if (input.replaces_job_id) {
      const old = legacyJob(principal, input.replaces_job_id);
      if (!['ready','invalid'].includes(old.state) || old.upload_id !== input.upload_id) throw new ApiError('CONFLICT', '같은 원본의 미완료 job만 대체할 수 있습니다.');
      db().prepare("UPDATE expense_import_jobs SET state='superseded' WHERE id=?").run(old.id);
    }
    const snapshot = makeSnapshot(upload.raw, input, legacyAccounts(principal), 'legacy');
    markIdentities(snapshot, legacyIdentities(principal, snapshot.rows));
    db().prepare("UPDATE expense_import_jobs SET state='superseded' WHERE tenant_id=? AND org_id=? AND actor_id=? AND upload_id=? AND state IN ('ready','invalid')")
      .run(...legacyScope(principal), input.upload_id);
    const job = { id: randomUUID(), upload_id: input.upload_id, source: 'legacy', snapshot, state: snapshotState(snapshot), created_at: clock() };
    db().prepare('INSERT INTO expense_import_jobs(id,tenant_id,org_id,actor_id,upload_id,snapshot,audit_snapshot,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(job.id, ...legacyScope(principal), job.upload_id, JSON.stringify(snapshot), JSON.stringify(auditSnapshot(snapshot)), job.state, job.created_at);
    return jobView(job);
  });
}
export function previewPgExpenseImport(req) {
  const input = previewSchema.parse(req.body);
  return withPgFinanceTransaction(req, async (client, principal) => {
    const { rows: [upload] } = await client.query('SELECT raw FROM accounting.expense_import_uploads WHERE company_id=$1 AND actor_id=$2 AND id=$3 AND expires_at>clock_timestamp() FOR SHARE', [...pgScope(principal), input.upload_id]);
    if (!upload) throw notFound('import upload');
    if (input.replaces_job_id) {
      const old = await pgJob(client, principal, input.replaces_job_id);
      if (!['ready','invalid'].includes(old.state) || old.upload_id !== input.upload_id) throw new ApiError('CONFLICT', '같은 원본의 미완료 job만 대체할 수 있습니다.');
      await client.query("UPDATE accounting.expense_import_jobs SET state='superseded' WHERE id=$1", [old.id]);
    }
    const snapshot = makeSnapshot(upload.raw, input, await pgAccounts(client, principal), 'perp_db');
    markIdentities(snapshot, await pgIdentities(client, principal, snapshot.rows));
    await client.query("UPDATE accounting.expense_import_jobs SET state='superseded' WHERE company_id=$1 AND actor_id=$2 AND upload_id=$3 AND state IN ('ready','invalid')", [...pgScope(principal), input.upload_id]);
    const { rows: [job] } = await client.query('INSERT INTO accounting.expense_import_jobs(id,company_id,actor_id,upload_id,snapshot,audit_snapshot,state) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING *',
      [randomUUID(), ...pgScope(principal), input.upload_id, JSON.stringify(snapshot), JSON.stringify(auditSnapshot(snapshot)), snapshotState(snapshot)]);
    return jobView(job);
  });
}
export function readLegacyExpenseImport(req, rows = false) {
  return withLegacyFinanceTransaction(req, principal => {
    principal.require('transaction.confirm');
    const job = legacyJob(principal, req.params.jobId);
    return rows ? rowPage(job, req.query) : jobView(job);
  });
}
export function readPgExpenseImport(req, rows = false) {
  return withPgFinanceTransaction(req, async (client, principal) => {
    const job = await pgJob(client, principal, req.params.jobId);
    return rows ? rowPage(job, req.query) : jobView(job);
  });
}

export function commitLegacyExpenseImport(req) {
  z.object({}).strict().parse(req.body);
  const key = requestKeySchema.parse(req.get('Idempotency-Key'));
  return withLegacyFinanceTransaction(req, principal => {
    // strict writer 내부 확인만으로는 replay를 보호하지 못한다.
    principal.require('transaction.confirm');
    const job = legacyJob(principal, req.params.jobId);
    assertReady(job, key); assertAccounts(job, legacyAccounts(principal));
    return replayLegacyMutation(req, principal, { operation: 'expense.import.commit', payload: { job_id: job.id } }, () => {
      if (job.state === 'completed') throw new ApiError('CONFLICT', '완료 응답의 재생 기록이 없습니다.');
      const identities = new Map(legacyIdentities(principal, job.snapshot.rows).map(row => [row.identity_key, row]));
      // 쓰기 시작 전 전행을 검증한다. 뒤의 어떤 writer/audit/result 실패도 같은 transaction을 전부 되돌린다.
      for (const row of job.snapshot.rows) if (row.disposition !== 'excluded') assertIdentity(row, identities.get(row.identity_key), job.id);
      const results = job.snapshot.rows.map(row => {
        let result = null;
        if (row.disposition === 'reuse') result = { id: row.existing_id };
        if (row.disposition === 'create') {
          result = { id: writeLegacyTransaction(principal, row.payload, req.requestId).id };
          db().prepare('INSERT INTO imported_transaction_identities(tenant_id,org_id,identity_key,identity_value,payload_sha256,transaction_id,job_id) VALUES(?,?,?,?,?,?,?)')
            .run(principal.tenantId, principal.orgId, row.identity_key, JSON.stringify(row.identity), row.payload_sha256, result.id, job.id);
        }
        return { logicalRecordOrdinal: row.logicalRecordOrdinal, disposition: row.disposition, result };
      });
      const response = importResult(job);
      audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action: 'expense.import.committed', resourceType: 'expense_import', resourceId: job.id, after: importAudit(job, results), requestId: req.requestId });
      db().prepare("UPDATE expense_import_jobs SET state='completed',request_key=?,result=?,result_rows=? WHERE id=?")
        .run(key, JSON.stringify(response), JSON.stringify(results), job.id);
      return response;
    });
  });
}
export function commitPgExpenseImport(req) {
  z.object({}).strict().parse(req.body);
  const key = requestKeySchema.parse(req.get('Idempotency-Key'));
  return withPgFinanceTransaction(req, async (client, principal) => {
    const job = await pgJob(client, principal, req.params.jobId);
    assertReady(job, key); assertAccounts(job, await pgAccounts(client, principal));
    return replayPgMutation(client, req, { operation: 'expense.import.commit', payload: { job_id: job.id } }, async () => {
      if (job.state === 'completed') throw new ApiError('CONFLICT', '완료 응답의 재생 기록이 없습니다.');
      const identities = new Map((await pgIdentities(client, principal, job.snapshot.rows)).map(row => [row.identity_key, row]));
      for (const row of job.snapshot.rows) if (row.disposition !== 'excluded') assertIdentity(row, identities.get(row.identity_key), job.id);
      const results = [];
      for (const row of job.snapshot.rows) {
        let result = null;
        if (row.disposition === 'reuse') result = { id: row.existing_id };
        if (row.disposition === 'create') {
          result = { id: (await postPgTransaction(client, req, row.payload)).id };
          await client.query('INSERT INTO accounting.imported_transaction_identities(company_id,identity_key,identity_value,payload_sha256,transaction_id,job_id) VALUES($1,$2,$3,$4,$5,$6)',
            [principal.companyId, row.identity_key, JSON.stringify(row.identity), row.payload_sha256, result.id, job.id]);
        }
        results.push({ logicalRecordOrdinal: row.logicalRecordOrdinal, disposition: row.disposition, result });
      }
      const response = importResult(job);
      await recordEvent(client, req, 'expense_imports', job.id, null, importAudit(job, results));
      await client.query("UPDATE accounting.expense_import_jobs SET state='completed',request_key=$1,result=$2::jsonb,result_rows=$3::jsonb WHERE id=$4", [key, JSON.stringify(response), JSON.stringify(results), job.id]);
      return response;
    });
  });
}

// 명시 운영 cleanup/스케줄러에서 호출한다. 만료 판정은 조회에서도 강제하며 raw를 응답/감사에 노출하지 않는다.
export function cleanupLegacyExpenseImports() {
  // Same write lock as commit; redact every job sharing the expired upload before deleting it.
  db().exec('BEGIN IMMEDIATE');
  try {
    const redacted = db().prepare(`UPDATE expense_import_jobs SET snapshot=audit_snapshot
      WHERE snapshot<>audit_snapshot AND NOT EXISTS (SELECT 1 FROM expense_import_uploads
        WHERE id=expense_import_jobs.upload_id AND julianday(expires_at)>julianday('now'))`).run().changes;
    const deleted = db().prepare("DELETE FROM expense_import_uploads WHERE julianday(expires_at)<=julianday('now')").run().changes;
    db().exec('COMMIT'); return { deleted, redacted };
  } catch (error) { db().exec('ROLLBACK'); throw error; }
}
export function cleanupPgExpenseImports() {
  return pgTransaction(async client => {
    const { rows: companies } = await client.query(`SELECT company_id FROM accounting.expense_import_uploads WHERE expires_at<=clock_timestamp()
      UNION SELECT company_id FROM accounting.expense_import_jobs j WHERE snapshot<>audit_snapshot
        AND NOT EXISTS (SELECT 1 FROM accounting.expense_import_uploads u WHERE u.id=j.upload_id AND u.expires_at>clock_timestamp())
      ORDER BY company_id`);
    let deleted = 0, redacted = 0;
    for (const { company_id: companyId } of companies) {
      // Always company -> jobs -> uploads, matching preview/commit. Recheck expiry under the lock.
      await client.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [companyId]);
      redacted += (await client.query(`UPDATE accounting.expense_import_jobs j SET snapshot=audit_snapshot
        WHERE company_id=$1 AND snapshot<>audit_snapshot AND NOT EXISTS (SELECT 1 FROM accounting.expense_import_uploads u
          WHERE u.id=j.upload_id AND u.expires_at>clock_timestamp())`, [companyId])).rowCount;
      deleted += (await client.query('DELETE FROM accounting.expense_import_uploads WHERE company_id=$1 AND expires_at<=clock_timestamp()', [companyId])).rowCount;
    }
    return { deleted, redacted };
  });
}
