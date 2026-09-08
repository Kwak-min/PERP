import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
// native fixture의 실제 연결은 runner의 unreachable-PG 100ms 기본값이 아닌 bounded 10s를 사용한다.
process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'native-receipts');
const evidence = new URL('../../.omo/evidence/task-16-deadline-erp-redesign/', import.meta.url);
const native = await startDailyNativePostgres();
let server, closePgPool, passed = false;
const scenarios = [], cleanup = { nativeClosed: false, serverClosed: false };
try {
  cleanup.native = (await native.pool.query("SELECT split_part(pg_read_file('postmaster.pid'),chr(10),1)::int AS pid,current_setting('port')::int AS port,current_setting('data_directory') AS directory")).rows[0];
  const ddl = await readFile(new URL('../../db/perp_additions_v12_deadline_expenses.sql', import.meta.url), 'utf8');
  await native.pool.query(ddl); await native.pool.query(ddl);
  server = await startTestServer();
  const pg = await import('../src/config/pg.js'); closePgPool = pg.closePgPool;
  const { resolvePgCompanyPrincipal } = await import('../src/middleware/pgAccess.js');
  const service = await import('../src/services/pg-receipt-files.service.js');
  const { receiptPath } = await import('../src/services/receipt-files.service.js');
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  async function request(actor, route, body, status = 200) {
    const response = await fetch(server.baseUrl + '/pg' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
      ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}), 'Idempotency-Key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result));
    scenarios.push({ route, status }); return result;
  }
  async function company(name) {
    const signup = await request(null, '/auth/signup', { name, email: `${name}@example.invalid`, password: 'password-1234' }, 201);
    const actor = { token: signup.token, userId: signup.user.id };
    const created = await request(actor, '/companies', { name, modules: ['finance', 'approvals'], features: ['approvals'] }, 201);
    actor.orgId = created.org_id; return actor;
  }
  const actor = await company('receipt-native-a'), foreign = await company('receipt-native-b');
  const principal = await resolvePgCompanyPrincipal({ authSource: 'perp_db', externalIdentity: { subject: actor.userId }, get: key => key === 'x-org-id' ? actor.orgId : undefined });
  await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'R_EXP','Receipt expense','expense'),($1,'R_CASH','Receipt cash','asset')", [principal.companyId]);
  const account = (await request(actor, '/finance/accounts')).items[0].value;
  const parent = await request(actor, '/finance/transactions', { account_id: account, amount: '100.01', entry_date: '2026-09-08' }, 201);
  const version = (await native.pool.query('SELECT xmin::text AS version FROM accounting.journal_entries WHERE id=$1', [parent.id])).rows[0].version;
  async function upload(who = actor, data = png, route = '/finance/transactions/receipt-uploads', status = 201) {
    const response = await fetch(server.baseUrl + '/pg' + route, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'X-Org-Id': who.orgId,
      'Content-Type': 'image/png', 'X-Upload-Name': encodeURIComponent('원증빙.png') }, body: data, signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result));
    scenarios.push({ route, status, sha256: hash(data), bytes: data.length }); return result;
  }
  const staged = await upload();
  const other = await upload(foreign);
  const options = tokens => ({ kind: 'transaction', parentId: parent.id, expectedVersion: version, tokens });
  const consume = tokens => pg.pgTransaction(client => service.consumePgReceipts(client, principal, options(tokens)));
  await assert.rejects(consume([other.token]), { code: 'NOT_FOUND' });
  await assert.rejects(pg.pgTransaction(client => service.consumePgReceipts(client, principal, { ...options([staged.token]), expectedVersion: 'stale' })), { code: 'VERSION_CONFLICT' });
  const [file] = await consume([staged.token]);
  const login = await request(null, '/auth/login', { email: 'receipt-native-a@example.invalid', password: 'password-1234' });
  const download = `/finance/transactions/${parent.id}/receipts/${file.file_id}`;
  const response = await fetch(server.baseUrl + '/pg' + download, { headers: { Authorization: `Bearer ${login.token}`, 'X-Org-Id': actor.orgId }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(png));
  assert.match(response.headers.get('content-disposition'), /^attachment;/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  await request(foreign, download, undefined, 404);
  await assert.rejects(native.pool.query('DELETE FROM accounting.journal_entry_files WHERE file_id=$1', [file.file_id]), { code: '23514' });
  await assert.rejects(native.pool.query("UPDATE files.objects SET original_name='changed' WHERE id=$1", [file.file_id]), { code: '23514' });
  scenarios.push({ nativeDownload: download, status: 200, sha256: hash(png), relogin: true });

  // 두 실제 client를 먼저 BEGIN 한 다음 같은 token을 동시에 소비한다. 타이머 운에 의존하지 않는다.
  const raceUpload = await upload(), clients = await Promise.all([native.pool.connect(), native.pool.connect()]);
  try {
    await Promise.all(clients.map(client => client.query('BEGIN')));
    const outcomes = await Promise.allSettled(clients.map(async client => {
      try { const result = await service.consumePgReceipts(client, principal, options([raceUpload.token])); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    }));
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, 'NOT_FOUND');
    scenarios.push({ race: 'two native transactions consume one token', winners: 1, rejected: 1 });
  } finally { clients.forEach(client => client.release()); }

  // 실제 rollback: audit 저장 실패 뒤 원본 object/link/token이 모두 복구되어야 한다.
  const rollback = await upload();
  await native.pool.query(`CREATE FUNCTION files.test_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt audit injected'; END $$;
    CREATE TRIGGER test_receipt_failure BEFORE INSERT ON files.receipt_events FOR EACH ROW EXECUTE FUNCTION files.test_receipt_failure()`);
  try { await assert.rejects(consume([rollback.token]), /receipt audit injected/); }
  finally { await native.pool.query('DROP TRIGGER test_receipt_failure ON files.receipt_events; DROP FUNCTION files.test_receipt_failure()'); }
  assert.equal((await native.pool.query('SELECT state FROM files.receipt_uploads WHERE token_hash=$1', [hash(rollback.token)])).rows[0].state, 'ready');
  await consume([rollback.token]);

  // cleanup은 만료된 옛 snapshot을 보지만 소비 transaction이 가진 row lock을 건너뛴다.
  const protectedUpload = await upload(), protectedHash = hash(protectedUpload.token);
  await native.pool.query("UPDATE files.receipt_uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [protectedHash]);
  const claimant = await native.pool.connect();
  try {
    await claimant.query('BEGIN');
    await claimant.query("UPDATE files.receipt_uploads SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1", [protectedHash]);
    const [claimed] = await service.consumePgReceipts(claimant, principal, options([protectedUpload.token]));
    const beforeCommit = await service.cleanupPgReceipts(); assert.equal(beforeCommit.deleted, 0);
    await claimant.query('COMMIT');
    const stored = (await native.pool.query('SELECT storage_key FROM files.objects WHERE id=$1', [claimed.file_id])).rows[0];
    assert.ok(existsSync(receiptPath(stored.storage_key)));
    scenarios.push({ race: 'cleanup skips locked attach', deleted: 0, filePreserved: true });
  } catch (error) { await claimant.query('ROLLBACK'); throw error; }
  finally { claimant.release(); }

  const approval = await request(actor, '/approvals', { request_type: 'receipt-review', note: 'Original attachment' }, 201);
  const approvalUpload = await upload(actor, png, '/approvals/receipt-uploads');
  const approvalVersion = (await native.pool.query('SELECT xmin::text AS version FROM org.approval_requests WHERE id=$1', [approval.id])).rows[0].version;
  const approvalOptions = { kind: 'approval', parentId: approval.id, expectedVersion: approvalVersion, tokens: [approvalUpload.token] };
  await assert.rejects(consume([approvalUpload.token]), { code: 'NOT_FOUND' });
  const [approvalFile] = await pg.pgTransaction(client => service.consumePgReceipts(client, principal, approvalOptions));
  await request(foreign, `/approvals/${approval.id}/receipts/${approvalFile.file_id}`, undefined, 404);
  const approvalResponse = await fetch(server.baseUrl + `/pg/approvals/${approval.id}/receipts/${approvalFile.file_id}`, { headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId }, signal: AbortSignal.timeout(10000) });
  assert.equal(approvalResponse.status, 200); assert.equal(hash(Buffer.from(await approvalResponse.arrayBuffer())), hash(png));
  await native.pool.query("UPDATE org.company_feature_settings SET enabled_features='{}' WHERE company_id=$1", [principal.companyId]);
  try { await assert.rejects(pg.pgTransaction(client => service.consumePgReceipts(client, principal, { ...approvalOptions, expectedVersion: 'stale' })), { code: 'FEATURE_DISABLED' }); }
  finally { await native.pool.query("UPDATE org.company_feature_settings SET enabled_features=ARRAY['approvals'] WHERE company_id=$1", [principal.companyId]); }

  const disabledUpload = await upload();
  await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='finance'", [principal.companyId]);
  try { await assert.rejects(pg.pgTransaction(client => service.consumePgReceipts(client, principal, { ...options([disabledUpload.token]), expectedVersion: 'stale' })), { code: 'MODULE_DISABLED' }); }
  finally { await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'finance')", [principal.companyId]); }

  // 현 권한 확인은 오래된 principal/version보다 우선한다.
  const revoked = await upload();
  await native.pool.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND p.code='transaction.write'", [principal.companyId]);
  await assert.rejects(pg.pgTransaction(client => service.consumePgReceipts(client, principal, { ...options([revoked.token]), expectedVersion: 'stale' })), { code: 'PERMISSION_DENIED' });
  await upload(actor, png, '/finance/transactions/receipt-uploads', 403);
  const clean = await upload(foreign), shared = await upload(foreign);
  const sharedRow = (await native.pool.query('SELECT * FROM files.receipt_uploads WHERE token_hash=$1', [hash(shared.token)])).rows[0];
  await native.pool.query("INSERT INTO files.objects(company_id,original_name,extension,storage_bucket,storage_key) VALUES($1,'shared.png','.png','orbitflow-local',$2)", [foreign.orgId.slice(3), sharedRow.storage_key]);
  await native.pool.query("UPDATE files.receipt_uploads SET expires_at=clock_timestamp()-interval '1 second'");
  const cleaned = await service.cleanupPgReceipts(); assert.ok(cleaned.deleted > 0); assert.equal(cleaned.shared, 1);
  assert.equal((await native.pool.query('SELECT state FROM files.receipt_uploads WHERE token_hash=$1', [hash(clean.token)])).rows[0].state, 'deleted');
  assert.ok(existsSync(receiptPath(sharedRow.storage_key)));
  assert.equal((await native.pool.query("SELECT COUNT(*)::int AS n FROM files.receipt_uploads WHERE state='consumed'")).rows[0].n, 5);
  scenarios.push({ cleanup: cleaned, sharedPreserved: true, consumedPreserved: 5, migrationAppliedTwice: true });
  passed = true;
  console.log(JSON.stringify({ passed, scenarios }, null, 2));
} finally {
  if (server) { await server.close(); cleanup.serverClosed = true; }
  await closePgPool?.(); await native.close(); cleanup.nativeClosed = true;
  if (cleanup.native) cleanup.native.directoryRemoved = !existsSync(cleanup.native.directory);
  await writeFile(new URL('native-scenario.json', evidence), JSON.stringify({ status: passed ? 'passed' : 'failed', scenarios }, null, 2));
  await writeFile(new URL('native-cleanup.json', evidence), JSON.stringify(cleanup, null, 2));
}
