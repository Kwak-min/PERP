import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer, createOwnerOrg, api } from './http.js';
import { readImportCleanupConfig, startImportCleanup } from '../src/services/expense-import-maintenance.js';

const csv = () => `external_id,expense_date,merchant,amount,account_code,memo\n${randomUUID()},2026-09-08,PRIVATE-MERCHANT,10.01,EXP,PRIVATE-RAW-MEMO\n`;

test('configured scheduled workers clean real expired imports in both stores, preserve active/committed originals, and retry SQLite busy next tick', { timeout: 120000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'maintenance-receipts');
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
    const legacy = await createOwnerOrg(server.baseUrl, ['finance']);
    const signup = await api(server.baseUrl, '/pg/auth/signup', { method: 'POST', body: { name: 'Maintenance', email: `${randomUUID()}@example.invalid`, password: 'password-1234' } });
    assert.equal(signup.status, 201);
    const pgActor = { token: signup.body.token };
    const company = await api(server.baseUrl, '/pg/companies', { ...pgActor, method: 'POST', body: { name: 'Maintenance fixture', modules: ['finance'] } });
    assert.equal(company.status, 201); pgActor.orgId = company.body.org_id;
    const companyId = pgActor.orgId.slice(3);
    const legacyAccount = await api(server.baseUrl, '/finance/accounts', { ...legacy, method: 'POST', body: { code: 'EXP', name: 'Expense', kind: 'expense' } });
    assert.equal(legacyAccount.status, 201);
    const pgAccount = (await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'EXP','Expense','expense') RETURNING id", [companyId])).rows[0].id;
    await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'CASH','Cash','asset')", [companyId]);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
    const fixtures = [];
    for (const [store, actor, account, route] of [['legacy',legacy,legacyAccount.body.id,''], ['perp_db',pgActor,pgAccount,'/pg']]) {
      const prefix = route + '/finance/transactions/imports';
      async function binary(url, body, type, headers = {}) {
        const response = await fetch(server.baseUrl + url, { method: 'POST', body, headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': type, ...headers }, signal: AbortSignal.timeout(10000) });
        const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); return data;
      }
      async function preview(patch = {}, uploadId) {
        const upload = uploadId ? { upload_id: uploadId } : await binary(prefix + '/uploads', csv(), 'text/csv');
        const response = await api(server.baseUrl, prefix, { ...actor, method: 'POST', body: { upload_id: upload.upload_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'No receipt', ...patch } });
        assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
      }
      const receipt = await binary(route + '/finance/transactions/receipt-uploads', png, 'image/png', { 'X-Upload-Name': 'original.png' });
      const superseded = await preview({ mapping_confirmed: false });
      const completed = await preview({ receipts: [{ logicalRecordOrdinal: 1, receipt_tokens: [receipt.token] }] }, superseded.upload_id);
      const key = randomUUID();
      const commit = await api(server.baseUrl, `${prefix}/${completed.job_id}/commit`, { ...actor, method: 'POST', body: {}, headers: { 'Idempotency-Key': key } });
      assert.equal(commit.status, 200, JSON.stringify(commit.body));
      const pending = await preview(), invalid = await preview({ mapping_confirmed: false }), active = await preview();
      const jobs = [superseded,completed,pending,invalid];
      const expire = async ids => store === 'legacy'
        ? ids.forEach(id => db().prepare("UPDATE expense_import_uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id))
        : native.pool.query("UPDATE accounting.expense_import_uploads SET expires_at='2000-01-01' WHERE id=ANY($1::uuid[])", [ids]);
      const stored = async () => store === 'legacy' ? db().prepare('SELECT * FROM expense_import_jobs ORDER BY id').all()
        : (await native.pool.query('SELECT * FROM accounting.expense_import_jobs ORDER BY id')).rows;
      const uploads = async () => store === 'legacy' ? db().prepare('SELECT * FROM expense_import_uploads ORDER BY id').all()
        : (await native.pool.query('SELECT * FROM accounting.expense_import_uploads ORDER BY id')).rows;
      await expire([completed.upload_id,pending.upload_id,invalid.upload_id]);
      fixtures.push({ store, actor, prefix, jobs, active, completed, key, commit, preview, expire, stored, uploads, before: await stored(), uploadsBefore: await uploads() });
    }
    const legacyTables = ['transaction_record','transaction_evidence','file_object','receipt_upload','audit_event','finance_request_replay','imported_transaction_identities'];
    const pgTables = ['accounting.journal_entries','accounting.journal_lines','accounting.journal_entry_files','accounting.record_events','accounting.request_replays','files.objects','files.receipt_uploads','files.receipt_events','accounting.imported_transaction_identities'];
    const originals = async () => [legacyTables.map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), await Promise.all(pgTables.map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows))];
    const original = await originals();
    const shared = path.join(process.env.ORBITFLOW_UPLOAD_DIR, 'shared-unrelated.txt');
    await writeFile(shared, 'SHARED-ORIGINAL');
    const start = stores => startImportCleanup(readImportCleanupConfig({ ...process.env, ORBITFLOW_IMPORT_CLEANUP_STORES: stores }), { timers, log: record => records.push(record) });
    job = start('legacy'); assert.equal(typeof interval, 'function', 'runtime must install a scheduled callback');
    assert.deepEqual(await fixtures[0].stored(), fixtures[0].before, 'no immediate startup sweep');
    await interval(); await job.stop(); assert.equal(interval, undefined);
    assert.deepEqual(await fixtures[1].stored(), fixtures[1].before, 'unconfigured PG remains untouched');
    assert.deepEqual(await fixtures[1].uploads(), fixtures[1].uploadsBefore);
    job = start('legacy,perp_db'); await interval();
    for (const fixture of fixtures) {
      const after = await fixture.stored();
      for (const expected of fixture.jobs) {
        const row = after.find(r => r.id === expected.job_id), before = fixture.before.find(r => r.id === expected.job_id);
        assert.deepEqual({ ...row }, { ...before, snapshot: before.audit_snapshot });
        assert.equal(JSON.stringify(row.snapshot).includes('PRIVATE-RAW-MEMO'), false);
      }
      assert.deepEqual(after.find(r => r.id === fixture.active.job_id), fixture.before.find(r => r.id === fixture.active.job_id));
      assert.deepEqual(await fixture.uploads(), fixture.uploadsBefore.filter(r => r.id === fixture.active.upload_id));
      const replay = await api(server.baseUrl, `${fixture.prefix}/${fixture.completed.job_id}/commit`, { ...fixture.actor, method: 'POST', body: {}, headers: { 'Idempotency-Key': fixture.key } });
      assert.deepEqual(replay, fixture.commit);
    }
    assert.deepEqual(await originals(), original);
    assert.equal(await readFile(shared, 'utf8'), 'SHARED-ORIGINAL');
    assert.ok(records.some(r => r.store === 'legacy' && r.deleted === 3 && r.redacted === 4));
    assert.ok(records.some(r => r.store === 'perp_db' && r.deleted === 3 && r.redacted === 4));
    const busy = await fixtures[0].preview(); await fixtures[0].expire([busy.upload_id]);
    db().exec('BEGIN IMMEDIATE');
    try {
      await interval();
      assert.ok(records.some(r => r.store === 'legacy' && r.status === 'failed' && r.reason === 'busy' && r.retry === 'next_tick'));
      assert.ok((await fixtures[0].uploads()).some(r => r.id === busy.upload_id));
    } finally { db().exec('COMMIT'); }
    await interval(); assert.equal((await fixtures[0].uploads()).some(r => r.id === busy.upload_id), false);
    const failing = await fixtures[1].preview(); await fixtures[1].expire([failing.upload_id]);
    await native.pool.query(`CREATE FUNCTION accounting.maintenance_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE-RAW-MEMO credentials'; END $$;
      CREATE TRIGGER maintenance_fail BEFORE DELETE ON accounting.expense_import_uploads FOR EACH ROW EXECUTE FUNCTION accounting.maintenance_fail()`);
    try { await interval(); assert.ok((await fixtures[1].uploads()).some(r => r.id === failing.upload_id)); }
    finally { await native.pool.query('DROP TRIGGER maintenance_fail ON accounting.expense_import_uploads; DROP FUNCTION accounting.maintenance_fail()'); }
    assert.ok(records.some(r => r.store === 'perp_db' && r.reason === 'cleanup_error'));
    await interval(); assert.equal((await fixtures[1].uploads()).some(r => r.id === failing.upload_id), false);
    assert.equal(JSON.stringify(records).includes('PRIVATE-'), false);
    console.log(JSON.stringify({ scheduledMaintenance: records, preservedOriginals: true, sqliteBusyRetried: true, pgFailureRetried: true }));
  } finally {
    await job?.stop(); assert.equal(interval, undefined);
    await server?.close();
    const { closePgPool } = await import('../src/config/pg.js'); await closePgPool();
    await native.close();
  }
});
