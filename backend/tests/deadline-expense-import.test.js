import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import { startTestServer, createOwnerOrg, api } from './http.js';
import { transportRegression, retentionRegression, chunkedCommit } from './expense-import-revision-cases.js';

const evidence = new URL('../../.omo/evidence/task-20-revision/', import.meta.url);
const header = 'external_id,expense_date,merchant,amount,account_code,memo\n';
const csv = (id = '', amount = '100.01') => header + `${id},2026-09-08,  Merchant  ,${amount},EXP, memo \n`;

test('immutable CSV jobs use one native SQLite write transaction and strict HTTP snapshots', { timeout: 120000 }, async t => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  process.env.ORBITFLOW_UPLOAD_DIR = `${process.env.DEADLINE_TEMP_ROOT}/import-receipts`;
  const server = await startTestServer(), scenarios = [];
  try {
    const { db } = await import('../src/config/db.js');
    const actor = await createOwnerOrg(server.baseUrl, ['finance']);
    const foreign = await createOwnerOrg(server.baseUrl, ['finance']);
    const account = (await api(server.baseUrl, '/finance/accounts', { ...actor, method: 'POST', body: { code: 'EXP', name: 'Expense', kind: 'expense' } })).body.id;
    const prefix = '/finance/transactions/imports';
    const request = async (route, body, status = 201, who = actor, key = randomUUID(), method = 'POST') => {
      const result = await api(server.baseUrl, prefix + route, { ...who, method, body, headers: key === null ? {} : { 'Idempotency-Key': key } });
      scenarios.push({ route, status: result.status, body: result.body });
      assert.equal(result.status, status, JSON.stringify(result.body)); return result.body;
    };
    const upload = async (raw, status = 201, who = actor) => {
      const response = await fetch(server.baseUrl + prefix + '/uploads', { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'X-Org-Id': who.orgId, 'Content-Type': 'text/csv' }, body: raw, signal: AbortSignal.timeout(10000) });
      const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
    };
    const preview = async (raw, patch = {}) => {
      const source = await upload(raw);
      return request('', { upload_id: source.upload_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'Receipt unavailable', ...patch });
    };
    const tables = ['transaction_record','transaction_evidence','file_object','receipt_upload','audit_event','finance_request_replay','expense_import_jobs','imported_transaction_identities'];
    const snapshot = () => tables.map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const revision = {
      preview,
      request: (job, body, key) => api(server.baseUrl, `${prefix}/${job.job_id}/commit`, { ...actor, method: 'POST', body, headers: { 'Idempotency-Key': key } }),
      snapshot,
      chunked: (job, key, body) => chunkedCommit(`${server.baseUrl}${prefix}/${job.job_id}/commit`, actor, key, body),
      denyExpiredReplay: async (job, key) => {
        db().prepare('UPDATE account SET active=0 WHERE id=?').run(account);
        try { await request(`/${job.job_id}/commit`, {}, 409, actor, key); }
        finally { db().prepare('UPDATE account SET active=1 WHERE id=?').run(account); }
        const membership = db().prepare('SELECT * FROM membership WHERE user_id=? AND org_id=?').get(actor.userId, actor.orgId);
        db().prepare("UPDATE membership SET roles='' WHERE id=?").run(membership.id);
        try { await request(`/${job.job_id}/commit`, {}, 403, actor, key); }
        finally { db().prepare('UPDATE membership SET roles=? WHERE id=?').run(membership.roles, membership.id); }
      },
      replace: (job, patch) => request('', { upload_id: job.upload_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'Receipt unavailable', ...patch }),
      get: (job, suffix = '') => api(server.baseUrl, `${prefix}/${job.job_id}${suffix}`, actor),
      expire: ids => ids.forEach(id => db().prepare("UPDATE expense_import_uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id)),
      cleanup: async () => (await import('../src/services/expense-import.service.js')).cleanupLegacyExpenseImports(),
      cleanupRollback: async () => {
        const before = snapshot(), uploads = db().prepare('SELECT * FROM expense_import_uploads ORDER BY id').all();
        db().exec("CREATE TRIGGER cleanup_failure BEFORE DELETE ON expense_import_uploads BEGIN SELECT RAISE(ABORT,'cleanup injected failure'); END");
        try { await assert.rejects(revision.cleanup(), /cleanup injected failure/); }
        finally { db().exec('DROP TRIGGER cleanup_failure'); }
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(db().prepare('SELECT * FROM expense_import_uploads ORDER BY id').all(), uploads);
      },
      stored: job => { const row = db().prepare('SELECT * FROM expense_import_jobs WHERE id=?').get(job.job_id); return { ...row, snapshot: JSON.parse(row.snapshot), audit_snapshot: JSON.parse(row.audit_snapshot) }; },
      originals: () => tables.filter(table => table !== 'expense_import_jobs').map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      absentUpload: id => !db().prepare('SELECT id FROM expense_import_uploads WHERE id=?').get(id),
      denyMutation: (job, expired) => {
        for (const change of ["snapshot='{}'", "audit_snapshot='{}'", "snapshot=audit_snapshot,result='{}'", "snapshot=audit_snapshot,actor_id='other'", ...(!expired ? ['snapshot=audit_snapshot'] : [])]) {
          assert.throws(() => db().prepare(`UPDATE expense_import_jobs SET ${change} WHERE id=?`).run(job.job_id), /immutable/);
        }
        assert.throws(() => db().prepare('DELETE FROM expense_import_jobs WHERE id=?').run(job.job_id), /immutable/);
        assert.throws(() => db().prepare("UPDATE imported_transaction_identities SET payload_sha256='changed'").run(), /immutable/);
        assert.throws(() => db().prepare('DELETE FROM imported_transaction_identities').run(), /immutable/);
      },
    };
    let first, key, result;
    await t.test('commit cannot substitute CSV, rows, mapping or scope, including replay', async () => {
      first = await preview(csv()); assert.equal(first.state, 'ready'); key = randomUUID();
      const before = snapshot();
      for (const body of [{ rows: [] }, { csv: csv('different') }, { mapping: [] }, { company_id: foreign.orgId }, [], null]) await request(`/${first.job_id}/commit`, body, 400);
      await request(`/${first.job_id}/commit`, {}, 400, actor, null);
      await request(`/${first.job_id}/commit`, {}, 404, foreign);
      assert.deepEqual(snapshot(), before);
      result = await request(`/${first.job_id}/commit`, {}, 200, actor, key);
      assert.equal(result.summary.created, 1); assert.equal(result.summary.amount, '100.01');
      const rows = await request(`/${first.job_id}/rows`, undefined, 200, actor, null, 'GET');
      assert.equal(rows.items[0].result.id, db().prepare('SELECT id FROM transaction_record').get().id);
      assert.equal(db().prepare('SELECT counterparty FROM transaction_record').get().counterparty, '  Merchant  ');
      const committed = snapshot();
      assert.deepEqual(await request(`/${first.job_id}/commit`, {}, 200, actor, key), result);
      await request(`/${first.job_id}/commit`, { rows: [] }, 400, actor, key);
      await request(`/${first.job_id}/commit`, {}, 409);
      assert.deepEqual(snapshot(), committed);
    });
    await t.test('confirmation and missing reason block ready; immutable replacement supersedes old job', async () => {
      const invalid = await preview(csv('confirm'), { mapping_confirmed: false, no_receipt_reason: undefined });
      assert.equal(invalid.state, 'invalid'); await request(`/${invalid.job_id}/commit`, {}, 409);
      const replacement = await request('', { upload_id: invalid.upload_id, replaces_job_id: invalid.job_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'Missing' });
      assert.equal(replacement.state, 'ready'); await request(`/${invalid.job_id}/commit`, {}, 409);
      assert.throws(() => db().prepare("UPDATE expense_import_jobs SET snapshot='{}' WHERE id=?").run(replacement.job_id), /immutable/);
      const latest = await request('', { upload_id: invalid.upload_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'Changed mapping review' });
      assert.notEqual(latest.job_id, replacement.job_id); await request(`/${replacement.job_id}/commit`, {}, 409);
      assert.equal((await preview(csv('missing-only'), { no_receipt_reason: undefined })).state, 'invalid');
      assert.equal((await preview(csv('confirmation-only'), { mapping_confirmed: false })).state, 'invalid');
      const overflow = await preview(csv('legacy-overflow', '90071992547409.92'));
      assert.equal(overflow.state, 'invalid'); assert.equal(overflow.summary.amount, '0.00');
      await request(`/${overflow.job_id}/commit`, {}, 409);
    });
    await t.test('identical separate logical rows stay separate; explicit duplicates reuse; changed payload conflicts', async () => {
      const two = await preview(csv() + ',2026-09-08,  Merchant  ,100.01,EXP, memo \n');
      const done = await request(`/${two.job_id}/commit`, {}, 200); assert.equal(done.summary.created, 2); assert.equal(done.summary.amount, '200.02');
      const dupe = await preview(csv()); assert.equal(dupe.state, 'invalid');
      const confirmed = await request('', { upload_id: dupe.upload_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'Receipt unavailable', duplicate_ordinals: [1] });
      assert.equal((await request(`/${confirmed.job_id}/commit`, {}, 200)).summary.reused, 1);
      const external = await preview(csv('stable')); await request(`/${external.job_id}/commit`, {}, 200);
      const changed = await preview(csv('stable', '100.02')); assert.equal(changed.state, 'invalid');
      await request(`/${changed.job_id}/commit`, {}, 409);
      const fresh = await preview(csv('key-other')); await request(`/${fresh.job_id}/commit`, {}, 409, actor, key);
    });
    await t.test('two actors racing one identity cannot partially save their other selected row', async () => {
      const signup = await api(server.baseUrl, '/auth/signup', { method: 'POST', body: { email: `import-${randomUUID()}@example.invalid`, name: 'Importer', password: 'password-1234' } });
      assert.equal(signup.status, 201);
      const second = { token: signup.body.access_token, userId: signup.body.user.id, orgId: actor.orgId };
      const member = db().prepare('SELECT * FROM membership WHERE user_id=? AND org_id=?').get(actor.userId, actor.orgId), now = new Date().toISOString(), role = randomUUID();
      db().prepare('INSERT INTO company_role(id,tenant_id,org_id,name,scope,permissions_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(role, member.tenant_id, actor.orgId, 'Finance importer', 'all', JSON.stringify(['transaction.read','transaction.write','transaction.confirm','menu.finance']), now, now);
      db().prepare('INSERT INTO membership(id,tenant_id,org_id,user_id,roles,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), member.tenant_id, actor.orgId, second.userId, role, now, now);
      const a = await preview(csv('raced') + 'only-a,2026-09-08,A,1.00,EXP,memo\n');
      const source = await upload(csv('raced') + 'only-b,2026-09-08,B,1.00,EXP,memo\n', 201, second);
      const b = await request('', { upload_id: source.upload_id, account_mapping: [{ account_code: 'EXP', account_id: account }], mapping_confirmed: true, no_receipt_reason: 'Receipt unavailable' }, 201, second);
      await request(`/${a.job_id}/commit`, {}, 404, second);
      const before = db().prepare('SELECT COUNT(*) AS n FROM transaction_record').get().n;
      const outcomes = await Promise.all([[actor,a],[second,b]].map(([who,job]) => api(server.baseUrl, `${prefix}/${job.job_id}/commit`, { ...who, method: 'POST', body: {}, headers: { 'Idempotency-Key': randomUUID() } })));
      assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [200,409]);
      assert.equal(db().prepare('SELECT COUNT(*) AS n FROM transaction_record').get().n, before + 2);
      scenarios.push({ nativeSqliteRace: outcomes.map(outcome => outcome.status), additionalRows: 2 });
    });
    await t.test('row N, audit, identity, replay and job-result failures roll back every selected row', async () => {
      const { default: sharp } = await import('sharp');
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
      const receiptResponse = await fetch(server.baseUrl + '/finance/transactions/receipt-uploads', { method: 'POST', headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'image/png', 'X-Upload-Name': 'receipt.png' }, body: png, signal: AbortSignal.timeout(10000) });
      const receipt = await receiptResponse.json(); assert.equal(receiptResponse.status, 201, JSON.stringify(receipt));
      const job = await preview(csv('failure-1') + 'failure-2,2026-09-08,Nth,100.01,EXP,memo\n', { receipts: [{ logicalRecordOrdinal: 1, receipt_tokens: [receipt.token] }] });
      for (const [table, op, condition] of [['transaction_record','INSERT',"NEW.counterparty='Nth'"],['file_object','INSERT','1'],['transaction_evidence','INSERT','1'],['receipt_upload','UPDATE',"NEW.state='consumed'"],['audit_event','INSERT',"NEW.action='receipt.attached'"],['audit_event','INSERT',"NEW.action='expense.import.committed'"],['imported_transaction_identities','INSERT','1'],['finance_request_replay','INSERT','1'],['expense_import_jobs','UPDATE',"NEW.state='completed'"]]) {
        const before = snapshot();
        db().exec(`CREATE TRIGGER import_test_failure BEFORE ${op} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'import injected failure'); END`);
        try { await request(`/${job.job_id}/commit`, {}, 500); }
        finally { db().exec('DROP TRIGGER import_test_failure'); }
        assert.deepEqual(snapshot(), before, table);
      }
      assert.equal((await request(`/${job.job_id}/commit`, {}, 200)).summary.created, 2);
      const lateReceipt = await preview(csv('consumed-token-first') + 'consumed-token-second,2026-09-08,Late,1.00,EXP,memo\n', { receipts: [{ logicalRecordOrdinal: 2, receipt_tokens: [receipt.token] }] });
      const beforeLate = snapshot();
      await request(`/${lateReceipt.job_id}/commit`, {}, 404);
      assert.deepEqual(snapshot(), beforeLate, 'late consumed receipt rolls back earlier row');
    });
    await t.test('current confirmation permission and active account are checked before replay', async () => {
      db().prepare('UPDATE account SET active=0 WHERE id=?').run(account);
      try { await request(`/${first.job_id}/commit`, {}, 409, actor, key); }
      finally { db().prepare('UPDATE account SET active=1 WHERE id=?').run(account); }
      const member = db().prepare('SELECT * FROM membership WHERE user_id=? AND org_id=?').get(actor.userId, actor.orgId);
      const now = new Date().toISOString(), role = randomUUID();
      db().prepare('INSERT INTO company_role(id,tenant_id,org_id,name,scope,permissions_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(role,member.tenant_id,actor.orgId,'Import writer','all',JSON.stringify(['transaction.read','transaction.write','menu.finance']),now,now);
      db().prepare('UPDATE membership SET roles=? WHERE id=?').run(role,member.id);
      try { await request(`/${first.job_id}/commit`, {}, 403, actor, key); }
      finally { db().prepare('UPDATE membership SET roles=? WHERE id=?').run(member.roles,member.id); }
    });
    await t.test('exact 5 MiB raw CSV survives transport; paginated errors and raw expiry are explicit', async () => {
      const n = 1400, base = ',2026-09-08,M,1.00,EXP,', size = 5 * 1024 * 1024;
      let left = size - Buffer.byteLength(header) - n * (Buffer.byteLength(base) + 1);
      const records = Array.from({ length: n }, () => { const count = Math.min(4000, left); left -= count; return base + 'x'.repeat(count) + '\n'; });
      const raw = header + records.join(''); assert.equal(Buffer.byteLength(raw), size); assert.equal(left, 0);
      const source = await upload(raw); assert.equal(source.logical_record_count, n); await upload(raw + 'x', 413);
      const job = await request('', { upload_id: source.upload_id, account_mapping: [], mapping_confirmed: false });
      const page = await request(`/${job.job_id}/rows?offset=25&limit=25&filter=errors`, undefined, 200, actor, null, 'GET');
      assert.equal(page.items.length, 25); assert.equal(page.items[0].logicalRecordOrdinal, 26); assert.equal(page.total, n);
      db().prepare("UPDATE expense_import_uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(source.upload_id);
      await request('', { upload_id: source.upload_id }, 404);
      const { cleanupLegacyExpenseImports } = await import('../src/services/expense-import.service.js');
      cleanupLegacyExpenseImports(); assert.equal(db().prepare('SELECT COUNT(*) AS n FROM expense_import_uploads WHERE id=?').get(source.upload_id).n, 0);
    });
    await t.test('literal empty JSON object is required before commit and replay', () => transportRegression(revision));
    await t.test('expiry denies and physically redacts every non-audit preview state', () => retentionRegression(revision));
    await t.test('native SQLite cleanup cannot erase input while the commit write lock is held', async () => {
      const active = await preview(csv('cleanup-lock'));
      const original = await revision.stored(active);
      db().exec('BEGIN IMMEDIATE');
      let worker;
      try {
        db().prepare("UPDATE expense_import_uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(active.upload_id);
        worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          parentPort.once('message', async () => {
            const { cleanupLegacyExpenseImports } = await import(workerData.service);
            const { closeDb } = await import(workerData.db);
            let result;
            try { result = { cleaned: cleanupLegacyExpenseImports() }; }
            catch (error) { result = { error: error.message, code: error.errcode }; }
            finally { closeDb(); }
            parentPort.postMessage(result);
          });
        `, { eval: true, workerData: { service: new URL('../src/services/expense-import.service.js', import.meta.url).href, db: new URL('../src/config/db.js', import.meta.url).href } });
        const done = once(worker, 'message', { signal: AbortSignal.timeout(10000) });
        worker.postMessage('cleanup');
        const [result] = await done;
        assert.equal(result.code, 5); assert.match(result.error, /locked/);
        assert.deepEqual(await revision.stored(active), original);
        assert.equal(await revision.absentUpload(active.upload_id), false);
        db().exec('COMMIT');
      } catch (error) { db().exec('ROLLBACK'); throw error; }
      finally { await worker?.terminate(); }
      assert.deepEqual(await revision.cleanup(), { deleted: 1, redacted: 1 });
      assert.equal((await revision.get(active, '/rows')).status, 410);
      scenarios.push({ sqliteCleanupLock: 'actual second-connection cleanup fails SQLITE_BUSY without touching active input; retry after lock release redacts', passed: true });
    });
  } finally {
    await server.close(); await mkdir(evidence, { recursive: true });
    await writeFile(new URL('scenario.json', evidence), JSON.stringify({ scenarios }, null, 2));
    await writeFile(new URL('cleanup.json', evidence), JSON.stringify({ serverClosed: true, sqliteRemoved: true, uploadsOwnedByIsolatedRunner: true }, null, 2));
  }
});
