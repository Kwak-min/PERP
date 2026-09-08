import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { transportRegression, retentionRegression, chunkedCommit } from './expense-import-revision-cases.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'import-receipts');
const evidence = new URL('../../.omo/evidence/task-20-revision/', import.meta.url);
await mkdir(evidence, { recursive: true });
const native = await startDailyNativePostgres(), events = new EventEmitter(), traces = [], scenarios = [], cleanup = {};
let server, closeDb, closePgPool, heldJob, passed = false;
const prefix = '/finance/transactions/imports';
const header = 'external_id,expense_date,merchant,amount,account_code,memo\n';
const csv = (external = '', amount = '100.01', merchant = '  Merchant  ') => header + `${external},2026-09-08,${merchant},${amount},EXP, memo \n`;
function companyQueries(n) {
  const signal = AbortSignal.timeout(10000);
  return new Promise((resolve, reject) => {
    const dispose = () => { events.off('company-query', onQuery); signal.removeEventListener('abort', onAbort); };
    const onQuery = () => { if (--n === 0) { dispose(); resolve(); } };
    const onAbort = () => { dispose(); reject(signal.reason); };
    events.on('company-query', onQuery); signal.addEventListener('abort', onAbort, { once: true });
  });
}
try {
  cleanup.native = (await native.pool.query("SELECT current_setting('port')::int AS port,current_setting('data_directory') AS directory,version() AS version")).rows[0];
  assert.match(cleanup.native.version, /PostgreSQL 18\./);
  const ddl = await readFile(new URL('../../db/perp_additions_v16_deadline_expense_imports.sql', import.meta.url), 'utf8');
  await native.pool.query(ddl); await native.pool.query(ddl);
  const pg = await import('../src/config/pg.js'); closePgPool = pg.closePgPool;
  // 관찰만 한다. mock/SQL 대체 없이 실제 client와 트리거, FK, row locks를 실행한다.
  pg.pgPool.on('connect', client => {
    const query = client.query.bind(client); let trace;
    client.query = (text, ...args) => {
      if (text === 'BEGIN') { trace = []; traces.push(trace); }
      trace?.push(String(text));
      const result = query(text, ...args);
      if (text === 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE') events.emit('company-query');
      if (text === 'COMMIT' || text === 'ROLLBACK') trace = undefined;
      // A bounded event gate delays only delivery of a real query result, holding real company/job locks.
      if (heldJob && String(text).startsWith('SELECT j.*') && args[0]?.[2] === heldJob.id) {
        const gate = heldJob; heldJob = undefined;
        return result.then(async value => { events.emit('job-loaded'); await gate.released; return value; });
      }
      return result;
    };
  });
  const { migrate } = await import('../src/config/migrate.js');
  const { createApp } = await import('../src/app.js');
  ({ closeDb } = await import('../src/config/db.js')); migrate();
  const app = createApp();
  server = createServer((req, res) => {
    if (req.headers['x-test-drop-response'] === 'yes') res.end = () => { res.destroy(); events.emit('response-dropped'); return res; };
    app(req, res);
  });
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await listening;
  cleanup.httpPort = server.address().port;
  const base = `http://127.0.0.1:${server.address().port}/api/v1/pg`;
  async function request(actor, route, body, options = {}) {
    const response = await fetch(base + route, { method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}),
        ...(options.key === null ? {} : { 'Idempotency-Key': options.key ?? randomUUID() }), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (options.status !== undefined) assert.equal(response.status, options.status, `${route}: ${JSON.stringify(result)}`);
    scenarios.push({ route, status: response.status, body: route.startsWith('/auth') ? { authenticated: Boolean(result.token) } : result });
    return { status: response.status, body: result };
  }
  async function signup(name) {
    const created = (await request(null, '/auth/signup', { name, email: `${name}@example.invalid`, password: 'password-1234' }, { status: 201 })).body;
    return { token: created.token, userId: created.user.id };
  }
  const owner = await signup('import-native-owner'), actor = await signup('import-native-writer');
  const company = (await request(owner, '/companies', { name: 'Import native', modules: ['finance'] }, { status: 201 })).body;
  owner.orgId = actor.orgId = company.org_id; owner.companyId = actor.companyId = company.org_id.slice(3);
  assert.deepEqual((await native.pool.query('SELECT module_key FROM org.company_modules WHERE company_id=$1', [owner.companyId])).rows, [{ module_key: 'finance' }]);
  // 격리 fixture의 두 번째 actor에는 재무 전용 유한 권한만 부여한다. 관리자 승격은 없다.
  await native.pool.query('INSERT INTO org.company_memberships(company_id,user_id) VALUES($1,$2)', [actor.companyId, actor.userId]);
  const role = (await native.pool.query("INSERT INTO org.roles(company_id,name) VALUES($1,'IMPORT_FINANCE_ONLY') RETURNING id", [actor.companyId])).rows[0].id;
  await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])", [role, ['transaction.read','transaction.write','menu.finance','menu.configured']]);
  await native.pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES($1,$2)', [actor.userId, role]);
  const account = (await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'EXP','Expense','expense') RETURNING id", [owner.companyId])).rows[0].id;
  await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'CASH','Cash','asset')", [owner.companyId]);
  const foreign = await signup('import-native-foreign');
  foreign.orgId = (await request(foreign, '/companies', { name: 'Foreign import', modules: ['finance'] }, { status: 201 })).body.org_id;
  const options = patch => ({ account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'Receipt unavailable', ...patch });
  async function upload(who, raw, status = 201) {
    const response = await fetch(base + prefix + '/uploads', { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'X-Org-Id': who.orgId, 'Content-Type': 'text/csv' }, body: raw, signal: AbortSignal.timeout(15000) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  }
  async function preview(who, raw, patch = {}) {
    const source = await upload(who, raw);
    return (await request(who, prefix, { upload_id: source.upload_id, ...options(patch) }, { status: 201 })).body;
  }
  const commit = (who, job, status = 200, key = randomUUID(), body = {}) => request(who, `${prefix}/${job.job_id}/commit`, body, { status, key });
  const rows = async (who, job) => (await request(who, `${prefix}/${job.job_id}/rows`, undefined, { status: 200 })).body.items;
  const tables = ['accounting.journal_entries','accounting.journal_lines','accounting.journal_entry_files','accounting.record_events','accounting.request_replays','files.objects','files.receipt_uploads','files.receipt_events','accounting.expense_import_jobs','accounting.imported_transaction_identities'];
  const snapshot = () => Promise.all(tables.map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
  const job = await preview(owner, csv('first')), key = randomUUID(); assert.equal(job.state, 'ready');
  const before = await snapshot();
  for (const body of [{ rows: [] }, { csv: csv('substitute') }, { mapping: [] }, { provider_source: 'evil' }, [], null]) await commit(owner, job, 400, randomUUID(), body);
  await commit(owner, job, 400, null); await commit(actor, job, 404); await commit(foreign, job, 404);
  assert.deepEqual(await snapshot(), before);
  const first = (await commit(owner, job, 200, key)).body, firstRows = await rows(owner, job);
  assert.equal(first.summary.amount, '100.01'); assert.equal(first.summary.created, 1);
  const posted = (await native.pool.query('SELECT * FROM accounting.journal_entries WHERE id=$1', [firstRows[0].result.id])).rows[0];
  assert.equal(posted.posted, true); assert.equal(posted.counterparty, '  Merchant  ');
  assert.deepEqual((await native.pool.query('SELECT SUM(debit)::text AS debit,SUM(credit)::text AS credit FROM accounting.journal_lines WHERE entry_id=$1', [posted.id])).rows[0], { debit: '100.01', credit: '100.01' });
  const committed = await snapshot();
  assert.deepEqual((await commit(owner, job, 200, key)).body, first);
  await commit(owner, job, 409); await commit(owner, job, 400, key, { rows: [] });
  await request(actor, `${prefix}/${job.job_id}/rows`, undefined, { status: 404 });
  assert.deepEqual(await snapshot(), committed);
  await assert.rejects(native.pool.query("UPDATE accounting.expense_import_jobs SET snapshot='{}'::jsonb WHERE id=$1", [job.job_id]), { code: '23514' });

  // 원본 논리 ordinal은 필터 전에 고정되고 동일 값의 서로 다른 행은 두 건이다.
  const identicalRaw = csv() + ',2026-09-08,  Merchant  ,100.01,EXP, memo \n';
  const identical = await preview(owner, identicalRaw); assert.equal((await commit(owner, identical)).body.summary.created, 2);
  const identicalRows = await rows(owner, identical); assert.notEqual(identicalRows[0].result.id, identicalRows[1].result.id);
  const excluded = await preview(owner, csv('excluded-1') + 'excluded-2,2026-09-08,Keep,1.00,EXP,memo\n', { excluded_ordinals: [1] });
  assert.equal((await commit(owner, excluded)).body.summary.created, 1); assert.equal((await rows(owner, excluded))[1].logicalRecordOrdinal, 2);
  const invalid = await preview(owner, csv('first', '100.02')); assert.equal(invalid.state, 'invalid');
  assert.equal((await rows(owner, invalid))[0].issues[0].code, 'IDENTITY_PAYLOAD_CONFLICT'); await commit(owner, invalid, 409);
  const dupe = await preview(actor, csv('first')); assert.equal(dupe.state, 'invalid');
  const reuse = await preview(actor, csv('first'), { duplicate_ordinals: [1] }); assert.equal((await commit(actor, reuse)).body.summary.reused, 1);
  assert.equal((await rows(actor, reuse))[0].result.id, String(posted.id));
  const otherKeyJob = await preview(owner, csv('key-new')); await commit(owner, otherKeyJob, 409, key);

  const largeExternalId = Array.from({ length: 128 }, () => randomUUID().replaceAll('-', '')).join('');
  assert.equal(Buffer.byteLength(largeExternalId), 4096);
  const largeIdentity = await preview(owner, csv(largeExternalId)); await commit(owner, largeIdentity);
  const largeReuse = await preview(actor, csv(largeExternalId), { duplicate_ordinals: [1] });
  assert.equal((await commit(actor, largeReuse)).body.summary.reused, 1);
  const replacement = await request(owner, prefix, { upload_id: otherKeyJob.upload_id, ...options({ no_receipt_reason: 'Reviewed again' }) }, { status: 201 });
  assert.equal(replacement.body.state, 'ready'); await commit(owner, otherKeyJob, 409);

  // 두 actor가 같은 identity와 각각의 신규 행을 선택한다. 회사 lock에서 실제로 둘 다 대기시킨다.
  const raceA = await preview(owner, csv('race') + 'race-owner,2026-09-08,Owner,1.00,EXP,memo\n');
  const raceB = await preview(actor, csv('race') + 'race-actor,2026-09-08,Actor,1.00,EXP,memo\n');
  const countBefore = (await native.pool.query('SELECT COUNT(*)::int AS n FROM accounting.journal_entries')).rows[0].n;
  const blocker = await native.pool.connect(); let racing;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [owner.companyId]);
    const queued = companyQueries(2);
    racing = Promise.all([request(owner, `${prefix}/${raceA.job_id}/commit`, {}), request(actor, `${prefix}/${raceB.job_id}/commit`, {})]);
    await queued; await blocker.query('COMMIT');
    const outcomes = await racing;
    assert.deepEqual(outcomes.map(result => result.status).sort(), [200,409]);
    assert.equal((await native.pool.query('SELECT COUNT(*)::int AS n FROM accounting.journal_entries')).rows[0].n, countBefore + 2);
    scenarios.push({ nativeRace: 'two actors queued at company lock; winner writes all two rows, loser writes none', statuses: outcomes.map(result => result.status) });
  } catch (error) { await blocker.query('ROLLBACK'); if (racing) await racing; throw error; }
  finally { blocker.release(); }

  // 실제 업로드/영수증 소비와 모든 쓰기 실패 지점을 같은 PG client에서 검증한다.
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
  async function receipt() {
    const response = await fetch(base + '/finance/transactions/receipt-uploads', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'X-Org-Id': owner.orgId, 'Content-Type': 'image/png', 'X-Upload-Name': 'native.png' }, body: png, signal: AbortSignal.timeout(10000) });
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return body.token;
  }
  const token = await receipt();
  const failure = await preview(owner, csv('failure-one') + 'failure-two,2026-09-08,Nth,100.01,EXP,memo\n', { receipts: [{ logicalRecordOrdinal: 1, receipt_tokens: [token] }] });
  const seams = [['accounting.journal_entries','INSERT',"NEW.counterparty='Nth'"], ['accounting.journal_lines','INSERT','NEW.credit>0'],
    ['files.objects','INSERT','true'], ['accounting.journal_entry_files','INSERT','true'], ['files.receipt_uploads','UPDATE',"NEW.state='consumed'"],
    ['files.receipt_events','INSERT','true'], ['accounting.record_events','INSERT',"NEW.resource='expense_imports'"],
    ['accounting.imported_transaction_identities','INSERT','true'], ['accounting.request_replays','INSERT','true'],
    ['accounting.request_replays','UPDATE','true'], ['accounting.expense_import_jobs','UPDATE',"NEW.state='completed'"]];
  for (const [table, operation, condition] of seams) {
    const previous = await snapshot();
    await native.pool.query(`CREATE FUNCTION accounting.t20_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 't20 injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER t20_failure BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION accounting.t20_failure()`);
    try { await commit(owner, failure, 500); }
    finally { await native.pool.query(`DROP TRIGGER t20_failure ON ${table}; DROP FUNCTION accounting.t20_failure()`); }
    assert.deepEqual(await snapshot(), previous, `${table} ${operation} left partial state`);
    scenarios.push({ injected: { table, operation, condition }, rollback: 'all journal/lines/receipts/audits/claims/replay/job state unchanged' });
  }
  await commit(owner, failure);
  const receiptId = (await rows(owner, failure))[0].result.id;
  assert.equal((await native.pool.query('SELECT COUNT(*)::int AS n FROM accounting.journal_entry_files WHERE entry_id=$1', [receiptId])).rows[0].n, 1);

  // socket은 controller가 COMMIT 결과를 받은 뒤 res.end에서 끊는다. retry는 기존 행 ID를 반환한다.
  const loss = await preview(owner, csv('response-loss')), lossKey = randomUUID();
  const dropped = once(events, 'response-dropped', { signal: AbortSignal.timeout(15000) });
  const lost = assert.rejects(request(owner, `${prefix}/${loss.job_id}/commit`, {}, { key: lossKey, headers: { 'X-Test-Drop-Response': 'yes' } }), /fetch failed/);
  await Promise.all([dropped, lost]);
  const afterLoss = await snapshot(), lossRows = await rows(owner, loss);
  await commit(owner, loss, 200, lossKey); assert.deepEqual(await rows(owner, loss), lossRows); assert.deepEqual(await snapshot(), afterLoss);
  scenarios.push({ responseLoss: 'real HTTP socket destroyed after COMMIT; exact row IDs replayed without new writes' });

  const accountJob = await preview(actor, csv('account-change'));
  await native.pool.query('UPDATE accounting.accounts SET is_active=false WHERE id=$1', [account]);
  try { await commit(actor, accountJob, 409); await commit(owner, job, 409, key); }
  finally { await native.pool.query('UPDATE accounting.accounts SET is_active=true WHERE id=$1', [account]); }
  await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='finance'", [owner.companyId]);
  try { await commit(owner, job, 403, key); }
  finally { await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'finance')", [owner.companyId]); }
  const actorReplay = await preview(actor, csv('actor-replay')), actorKey = randomUUID(); await commit(actor, actorReplay, 200, actorKey);
  const revoker = await native.pool.connect(); let pending;
  try {
    await revoker.query('BEGIN'); await revoker.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [owner.companyId]);
    const queued = companyQueries(1);
    pending = commit(actor, actorReplay, 403, actorKey); await queued;
    await revoker.query("DELETE FROM org.role_permissions WHERE role_id=$1 AND permission_id=(SELECT id FROM org.permissions WHERE code='transaction.write')", [role]);
    await revoker.query('COMMIT'); await pending;
    scenarios.push({ permissionRace: 'old middleware grant cannot replay after company-locked revocation', status: 403 });
  } catch (error) { await revoker.query('ROLLBACK'); if (pending) await pending; throw error; }
  finally { revoker.release(); }
  await commit(actor, accountJob, 403);

  const late = await preview(owner, csv('late-receipt-1') + 'late-receipt-2,2026-09-08,Late,1.00,EXP,memo\n', { receipts: [{ logicalRecordOrdinal: 2, receipt_tokens: [token] }] });
  const beforeLate = await snapshot(); await commit(owner, late, 404); assert.deepEqual(await snapshot(), beforeLate);
  scenarios.push({ currentReceiptRecheck: 'consumed token at row2 ->404; row1 and all persisted tables unchanged' });
  const n = 1400, record = ',2026-09-08,M,1.00,EXP,', size = 5242880;
  let left = size - Buffer.byteLength(header) - n * (Buffer.byteLength(record) + 1);
  const exactRaw = header + Array.from({ length: n }, () => { const count = Math.min(4000, left); left -= count; return record + 'x'.repeat(count) + '\n'; }).join('');
  assert.equal(Buffer.byteLength(exactRaw), size); assert.equal(left, 0);
  const largeUpload = await upload(owner, exactRaw); await upload(owner, exactRaw + 'x', 413);
  const largeJob = (await request(owner, prefix, { upload_id: largeUpload.upload_id, account_mapping: [], mapping_confirmed: false }, { status: 201 })).body;
  const largePage = (await request(owner, `${prefix}/${largeJob.job_id}/rows?offset=1300&limit=100&filter=errors`, undefined, { status: 200 })).body;
  assert.equal(largePage.total, n); assert.equal(largePage.items.length, 100); assert.equal(largePage.items[0].logicalRecordOrdinal, 1301);
  scenarios.push({ rawBoundary: { accepted: size, rejected: size + 1 }, paginatedOriginalOrdinal: 1301, total: n });

  const source = await upload(owner, csv('expire'));
  await native.pool.query("UPDATE accounting.expense_import_uploads SET expires_at='2000-01-01' WHERE id=$1", [source.upload_id]);
  await request(owner, prefix, { upload_id: source.upload_id, ...options() }, { status: 404 });
  const { cleanupPgExpenseImports } = await import('../src/services/expense-import.service.js');
  assert.equal((await cleanupPgExpenseImports()).deleted, 1);
  assert.equal((await native.pool.query('SELECT COUNT(*)::int AS n FROM accounting.expense_import_uploads WHERE id=$1', [source.upload_id])).rows[0].n, 0);
  const revision = {
    preview: (raw, patch) => preview(owner, raw, patch),
    request: (job, body, key) => request(owner, `${prefix}/${job.job_id}/commit`, body, { method: 'POST', key }),
    snapshot,
    chunked: (job, key, body) => chunkedCommit(`${base}${prefix}/${job.job_id}/commit`, owner, key, body),
    denyExpiredReplay: async (job, key) => {
      await native.pool.query('UPDATE accounting.accounts SET is_active=false WHERE id=$1', [account]);
      try { await commit(owner, job, 409, key); }
      finally { await native.pool.query('UPDATE accounting.accounts SET is_active=true WHERE id=$1', [account]); }
      await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='finance'", [owner.companyId]);
      try { await commit(owner, job, 403, key); }
      finally { await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'finance')", [owner.companyId]); }
    },
    replace: async (job, patch) => (await request(owner, prefix, { upload_id: job.upload_id, ...options(patch) }, { status: 201 })).body,
    get: (job, suffix = '') => request(owner, `${prefix}/${job.job_id}${suffix}`, undefined),
    expire: ids => native.pool.query("UPDATE accounting.expense_import_uploads SET expires_at='2000-01-01' WHERE id=ANY($1::uuid[])", [ids]),
    cleanup: cleanupPgExpenseImports,
    cleanupRollback: async () => {
      const before = await snapshot(), uploads = (await native.pool.query('SELECT * FROM accounting.expense_import_uploads ORDER BY id')).rows;
      await native.pool.query(`CREATE FUNCTION accounting.cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup injected failure'; END $$;
        CREATE TRIGGER cleanup_failure BEFORE DELETE ON accounting.expense_import_uploads FOR EACH ROW EXECUTE FUNCTION accounting.cleanup_failure()`);
      try { await assert.rejects(cleanupPgExpenseImports(), /cleanup injected failure/); }
      finally { await native.pool.query('DROP TRIGGER cleanup_failure ON accounting.expense_import_uploads; DROP FUNCTION accounting.cleanup_failure()'); }
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await native.pool.query('SELECT * FROM accounting.expense_import_uploads ORDER BY id')).rows, uploads);
    },
    stored: async job => (await native.pool.query('SELECT * FROM accounting.expense_import_jobs WHERE id=$1', [job.job_id])).rows[0],
    originals: () => Promise.all(tables.filter(table => table !== 'accounting.expense_import_jobs').map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)),
    absentUpload: async id => (await native.pool.query('SELECT id FROM accounting.expense_import_uploads WHERE id=$1', [id])).rowCount === 0,
    denyMutation: async (job, expired) => {
      for (const change of ["snapshot='{}'::jsonb", "audit_snapshot='{}'::jsonb", "snapshot=audit_snapshot,result='{}'::jsonb", 'snapshot=audit_snapshot,actor_id=0', ...(!expired ? ['snapshot=audit_snapshot'] : [])]) {
        await assert.rejects(native.pool.query(`UPDATE accounting.expense_import_jobs SET ${change} WHERE id=$1`, [job.job_id]), { code: '23514' });
      }
      await assert.rejects(native.pool.query('DELETE FROM accounting.expense_import_jobs WHERE id=$1', [job.job_id]), { code: '23514' });
      await assert.rejects(native.pool.query("UPDATE accounting.imported_transaction_identities SET payload_sha256='changed'"), { code: '23514' });
      await assert.rejects(native.pool.query('DELETE FROM accounting.imported_transaction_identities'), { code: '23514' });
    },
  };
  const revisionFailures = [];
  for (const regression of [transportRegression, retentionRegression]) {
    try { await regression(revision); scenarios.push({ regression: regression.name, passed: true }); }
    catch (error) { revisionFailures.push(error); console.error(regression.name, error); scenarios.push({ regression: regression.name, passed: false, error: error.message }); }
  }
  if (revisionFailures.length) throw new AggregateError(revisionFailures, 'Task20 revision acceptance failures');
  // The upload expires only after commit has read live input. Cleanup must wait, then redact the completed job.
  const activeCommit = await preview(owner, csv('cleanup-in-flight')), activeKey = randomUUID();
  const gate = Promise.withResolvers();
  heldJob = { id: activeCommit.job_id, released: gate.promise };
  const loaded = once(events, 'job-loaded', { signal: AbortSignal.timeout(10000) });
  const committing = commit(owner, activeCommit, 200, activeKey);
  let cleaning;
  try {
    await loaded;
    await revision.expire([activeCommit.upload_id]);
    const queued = companyQueries(1);
    cleaning = cleanupPgExpenseImports(); await queued;
    assert.equal(await revision.absentUpload(activeCommit.upload_id), false);
    assert.notDeepEqual((await revision.stored(activeCommit)).snapshot, (await revision.stored(activeCommit)).audit_snapshot);
    gate.resolve();
    const done = await committing;
    assert.equal(done.body.summary.created, 1);
    assert.deepEqual(await cleaning, { deleted: 1, redacted: 1 });
    assert.deepEqual((await commit(owner, activeCommit, 200, activeKey)).body, done.body);
    scenarios.push({ cleanupRace: 'commit holds live input; cleanup queues at company lock, then redacts without erasing ledger or replay', passed: true });
  } finally { gate.resolve(); await Promise.allSettled([committing, ...(cleaning ? [cleaning] : [])]); }
  const cleanupTraces = traces.filter(trace => trace[1]?.startsWith('SELECT company_id FROM accounting.expense_import_uploads'));
  for (const trace of cleanupTraces) {
    assert.equal(trace[0], 'BEGIN');
    const firstWrite = trace.findIndex(sql => sql.startsWith('UPDATE accounting.expense_import_jobs'));
    if (firstWrite !== -1) assert.equal(trace[firstWrite - 1], 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE');
    assert.equal(trace.filter(sql => sql === 'COMMIT' || sql === 'ROLLBACK').length, 1);
  }
  await writeFile(new URL('native-cleanup-traces.json', evidence), JSON.stringify(cleanupTraces, null, 2));
  const importTraces = traces.filter(trace => !cleanupTraces.includes(trace) && trace.some(sql => /expense_import_jobs/.test(sql)));
  assert.ok(importTraces.length > 20);
  for (const trace of importTraces) {
    assert.equal(trace[0], 'BEGIN'); assert.equal(trace[1], 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE');
    assert.equal(trace.filter(sql => sql === 'COMMIT' || sql === 'ROLLBACK').length, 1);
  }
  const auditRows = (await native.pool.query("SELECT after_data FROM accounting.record_events WHERE resource='expense_imports'")).rows;
  for (const row of auditRows) assert.deepEqual(Object.keys(row.after_data).sort(), ['counts','parser_version','raw_sha256','row_ids']);
  await writeFile(new URL('native-transaction-traces.json', evidence), JSON.stringify(importTraces, null, 2));
  passed = true;
  console.log(JSON.stringify({ passed, engine: cleanup.native.version, scenarios: scenarios.length, importTransactionTraces: importTraces.length }));
} finally {
  if (server) { const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); await closed; cleanup.serverClosed = true; }
  closeDb?.(); await closePgPool?.(); await native.close(); cleanup.nativeClosed = true;
  cleanup.nativeDirectoryRemoved = !existsSync(cleanup.native.directory);
  await writeFile(new URL('native-scenario.json', evidence), JSON.stringify({ passed, scenarios }, null, 2));
  await writeFile(new URL('native-cleanup.json', evidence), JSON.stringify(cleanup, null, 2));
}
