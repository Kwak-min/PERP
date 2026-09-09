import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer, createOwnerOrg, api } from './http.js';
import { readImportCleanupConfig, startImportCleanup } from '../src/services/expense-import-maintenance.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const csv = () => `external_id,expense_date,merchant,amount,account_code,memo\n${randomUUID()},2026-09-08,PRIVATE-MERCHANT,10.01,EXP,PRIVATE-MEMO\n`;

test('scheduled receipt workers target expired unconsumed stages only in configured native stores and preserve originals', { timeout: 120000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const root = path.join(process.env.DEADLINE_TEMP_ROOT, 'receipt-maintenance-root');
  await mkdir(root); process.env.ORBITFLOW_UPLOAD_DIR = root;
  const native = await startDailyNativePostgres();
  let server, job, interval;
  const records = [], timers = {
    setInterval(fn) { assert.equal(interval, undefined); interval = fn; return fn; },
    clearInterval(fn) { assert.equal(fn, interval); interval = undefined; },
  };
  try {
    await native.pool.query(await readFile(new URL('../../db/perp_additions_v16_deadline_expense_imports.sql', import.meta.url), 'utf8'));
    server = await startTestServer();
    const { db } = await import('../src/config/db.js');
    const { insert } = await import('../src/models/base.js');
    const legacy = await createOwnerOrg(server.baseUrl, ['finance']);
    const signup = await api(server.baseUrl, '/pg/auth/signup', { method: 'POST', body: { name: 'Receipt maintenance', email: `${randomUUID()}@example.invalid`, password: 'password-1234' } });
    assert.equal(signup.status, 201);
    const pgActor = { token: signup.body.token };
    const company = await api(server.baseUrl, '/pg/companies', { ...pgActor, method: 'POST', body: { name: 'Receipt fixture', modules: ['finance'] } });
    assert.equal(company.status, 201); pgActor.orgId = company.body.org_id;
    const companyId = pgActor.orgId.slice(3);
    const accountResponse = await api(server.baseUrl, '/finance/accounts', { ...legacy, method: 'POST', body: { code: 'EXP', name: 'Expense', kind: 'expense' } });
    assert.equal(accountResponse.status, 201);
    const pgAccount = (await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'EXP','Expense','expense') RETURNING id", [companyId])).rows[0].id;
    await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'CASH','Cash','asset')", [companyId]);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
    const fixtures = [];
    for (const [store,actor,account,route] of [['legacy',legacy,accountResponse.body.id,''],['perp_db',pgActor,pgAccount,'/pg']]) {
      async function binary(url, body, type) {
        const response = await fetch(server.baseUrl + route + url, { method: 'POST', body, headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': type, 'X-Upload-Name': 'PRIVATE-original.png' }, signal: AbortSignal.timeout(10000) });
        const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result;
      }
      const prefix = route + '/finance/transactions/imports';
      const stages = {};
      for (const name of ['ready','writing','active','activeWriting','consumed','shared','broken']) stages[name] = await binary('/finance/transactions/receipt-uploads', png, 'image/png');
      const upload = await binary('/finance/transactions/imports/uploads', csv(), 'text/csv');
      const preview = await api(server.baseUrl, prefix, { ...actor, method: 'POST', body: { upload_id: upload.upload_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, receipts: [{ logicalRecordOrdinal: 1, receipt_tokens: [stages.consumed.token] }] } });
      assert.equal(preview.status, 201);
      const committed = await api(server.baseUrl, `${prefix}/${preview.body.job_id}/commit`, { ...actor, method: 'POST', body: {}, headers: { 'Idempotency-Key': randomUUID() } });
      assert.equal(committed.status, 200, JSON.stringify(committed.body));
      const rows = async () => store === 'legacy' ? db().prepare('SELECT * FROM receipt_upload ORDER BY id').all()
        : (await native.pool.query('SELECT * FROM files.receipt_uploads ORDER BY id')).rows;
      const get = async name => (await rows()).find(row => row.token_hash === hash(stages[name].token));
      for (const name of ['writing','activeWriting']) {
        const row = await get(name);
        if (store === 'legacy') db().prepare("UPDATE receipt_upload SET state='writing' WHERE id=?").run(row.id);
        else await native.pool.query("UPDATE files.receipt_uploads SET state='writing' WHERE id=$1", [row.id]);
      }
      const shared = await get('shared');
      if (store === 'legacy') insert('file_object', { tenant_id: shared.tenant_id, org_id: shared.org_id, filename: 'shared.png', storage_key: shared.storage_key });
      else await native.pool.query("INSERT INTO files.objects(company_id,original_name,extension,storage_bucket,storage_key) VALUES($1,'shared.png','.png','orbitflow-local',$2)", [companyId,shared.storage_key]);
      const expire = async names => {
        const ids = await Promise.all(names.map(async name => (await get(name)).id));
        if (store === 'legacy') ids.forEach(id => db().prepare("UPDATE receipt_upload SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id));
        else await native.pool.query("UPDATE files.receipt_uploads SET expires_at='2000-01-01' WHERE id=ANY($1::uuid[])", [ids]);
      };
      await expire(['ready','writing','consumed','shared','broken']);
      const brokenPath = path.join(root, (await get('broken')).storage_key);
      await rm(brokenPath); await mkdir(brokenPath); await writeFile(path.join(brokenPath,'child'), 'PRIVATE-BLOCKED-FILE');
      fixtures.push({ store, rows, get, before: await rows(), brokenPath, upload });
    }
    const originals = async () => [
      ['transaction_record','transaction_evidence','file_object','audit_event','finance_request_replay','imported_transaction_identities'].map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      await Promise.all(['accounting.journal_entries','accounting.journal_lines','accounting.journal_entry_files','files.objects','files.receipt_events','accounting.record_events','accounting.request_replays','accounting.imported_transaction_identities'].map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)),
    ];
    const original = await originals(), unrelated = path.join(root,'unrelated.txt');
    await writeFile(unrelated,'SHARED-UNRELATED');
    const start = (imports,receipts) => startImportCleanup(readImportCleanupConfig({ ...process.env, ORBITFLOW_IMPORT_CLEANUP_STORES: imports, ORBITFLOW_RECEIPT_CLEANUP_STORES: receipts }), { timers, log: record => records.push(record) });
    job = start('legacy,perp_db',''); await interval(); await job.stop();
    for (const f of fixtures) assert.deepEqual(await f.rows(), f.before, 'CSV selection does not enable receipts');
    db().prepare("UPDATE expense_import_uploads SET expires_at='2000-01-01T00:00:00.000Z'").run();
    await native.pool.query("UPDATE accounting.expense_import_uploads SET expires_at='2000-01-01'");
    const imports = async () => [db().prepare('SELECT * FROM expense_import_uploads ORDER BY id').all(),db().prepare('SELECT * FROM expense_import_jobs ORDER BY id').all(),
      (await native.pool.query('SELECT * FROM accounting.expense_import_uploads ORDER BY id')).rows,(await native.pool.query('SELECT * FROM accounting.expense_import_jobs ORDER BY id')).rows];
    const importsBefore = await imports();
    job = start('','legacy');
    assert.equal(typeof interval, 'function', 'receipt-only configuration must schedule actual cleanup');
    db().exec('BEGIN IMMEDIATE');
    try { await interval(); assert.deepEqual(await fixtures[0].rows(), fixtures[0].before); }
    finally { db().exec('COMMIT'); }
    assert.ok(records.some(r => r.kind === 'receipts' && r.reason === 'busy' && r.retry === 'next_tick'));
    await interval(); await job.stop();
    assert.equal((await fixtures[0].get('ready')).state, 'deleted');
    assert.deepEqual(await fixtures[1].rows(), fixtures[1].before, 'unconfigured PG receipt staging stays untouched');
    job = start('','legacy,perp_db');
    // 원본 root가 사라졌으면 잘못된 빈 경로에서 삭제 완료를 기록하지 않는다.
    await rename(root,root + '-offline');
    try { await interval(); assert.deepEqual(await fixtures[1].rows(), fixtures[1].before); }
    finally { await rename(root + '-offline',root); }
    assert.ok(records.some(r => r.kind === 'receipts' && r.reason === 'store_unavailable'));
    await interval();
    for (const f of fixtures) {
      for (const name of ['ready','writing']) {
        const row = await f.get(name); assert.equal(row.state, 'deleted'); assert.equal(existsSync(path.join(root,row.storage_key)), false);
      }
      for (const name of ['active','activeWriting','consumed']) {
        const row = await f.get(name); assert.deepEqual(row,f.before.find(r => r.id === row.id));
        assert.equal(hash(await readFile(path.join(root,row.storage_key))),hash(png));
      }
      const shared = await f.get('shared'); assert.equal(shared.state,'ready'); assert.equal(shared.cleanup_error,'SHARED_OBJECT_PRESERVED');
      assert.equal(hash(await readFile(path.join(root,shared.storage_key))),hash(png));
      const broken = await f.get('broken'); assert.equal(broken.state,'ready'); assert.match(broken.cleanup_error,/^UNLINK_FAILED:/);
      assert.equal(await readFile(path.join(f.brokenPath,'child'),'utf8'),'PRIVATE-BLOCKED-FILE');
      assert.ok(records.some(r => r.kind === 'receipts' && r.store === f.store && r.status === 'failed' && r.reason === 'unlink_failed' && r.deleted === 2 && r.failed === 1 && r.shared === 1 && r.retry === 'next_tick'));
      await rm(f.brokenPath,{recursive:true}); await writeFile(f.brokenPath,png);
    }
    await interval();
    for (const f of fixtures) { assert.equal((await f.get('broken')).state,'deleted'); assert.equal(existsSync(f.brokenPath),false); }
    // PG SKIP LOCKED을 실제 별도 transaction으로 검증한다. 다음 tick이 잠금 해제된 staging을 재방문한다.
    const pgActive = await fixtures[1].get('active'), claimant = await native.pool.connect();
    await native.pool.query("UPDATE files.receipt_uploads SET expires_at='2000-01-01' WHERE id=$1",[pgActive.id]);
    try {
      await claimant.query('BEGIN'); await claimant.query('SELECT id FROM files.receipt_uploads WHERE id=$1 FOR UPDATE',[pgActive.id]);
      await interval(); assert.equal((await fixtures[1].get('active')).state,'ready'); assert.ok(existsSync(path.join(root,pgActive.storage_key)));
      await claimant.query('COMMIT');
    } catch (error) { await claimant.query('ROLLBACK'); throw error; }
    finally { claimant.release(); }
    await interval(); assert.equal((await fixtures[1].get('active')).state,'deleted');
    assert.deepEqual(await imports(),importsBefore,'receipt-only selection does not clean even expired CSV');
    assert.deepEqual(await originals(),original); assert.equal(await readFile(unrelated,'utf8'),'SHARED-UNRELATED');
    assert.equal(JSON.stringify(records).includes('PRIVATE-'),false); assert.equal(JSON.stringify(records).includes(root),false);
    console.log(JSON.stringify({ receiptMaintenance: records, originalFilesPreserved: true, noCrossKindEnablement: true, nativeSkipLocked: true }));
  } finally {
    await job?.stop(); assert.equal(interval,undefined); await server?.close();
    const { closePgPool } = await import('../src/config/pg.js'); await closePgPool(); await native.close();
  }
});
