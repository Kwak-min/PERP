import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'revision-receipts');
const evidence = new URL('../../.omo/evidence/task-17-revision/', import.meta.url);
await mkdir(evidence, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('task17 revision: actual HTTP compatible boundaries, reload and account options', { timeout: 120000 }, async t => {
  const native = await startDailyNativePostgres(), scenarios = [], cleanup = {};
  let server, closeDb, closePgPool;
  try {
    cleanup.native = (await native.pool.query("SELECT current_setting('data_directory') AS directory,current_setting('port') AS port,version() AS version")).rows[0];
    const pg = await import('../src/config/pg.js'); closePgPool = pg.closePgPool;
    const { createApp } = await import('../src/app.js');
    const { migrate } = await import('../src/config/migrate.js');
    const sqlite = await import('../src/config/db.js'); closeDb = sqlite.closeDb; migrate();
    server = createServer(createApp());
    const listening = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await listening;
    const base = `http://127.0.0.1:${server.address().port}/api/v1`; cleanup.httpPort = server.address().port;
    async function request(actor, route, body, status = 201, key = randomUUID()) {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
        'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}),
        ...(key === null ? {} : { 'Idempotency-Key': key }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      scenarios.push({ route, status: response.status, body: route.includes('/auth/') ? { authenticated: Boolean(result.token ?? result.access_token) } : result });
      if (status !== null) assert.equal(response.status, status, JSON.stringify(result));
      return { status: response.status, body: result };
    }
    async function company(prefix, name) {
      const signup = await request(null, prefix + '/auth/signup', { name, email: `${name}@example.invalid`, password: 'password-1234' });
      const actor = { token: signup.body.token ?? signup.body.access_token };
      const created = await request(actor, prefix ? '/pg/companies' : '/tenants', prefix ? { name, modules: ['finance'] } : { name, type: 'custom', modules: ['finance'], features: [], departments: [] });
      actor.orgId = created.body.org_id; actor.companyId = actor.orgId.replace(/^pg:/, ''); return actor;
    }
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
    for (const prefix of ['', '/pg']) {
      const name = prefix ? 'PG' : 'legacy';
      const actor = await company(prefix, `revision-${name}-a`), foreign = await company(prefix, `revision-${name}-b`);
      async function account(who, code, kind) {
        if (prefix) return String((await native.pool.query('INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,$2,$2,$3) RETURNING id', [who.companyId, code, kind])).rows[0].id);
        return (await request(who, '/finance/accounts', { code, name: code, kind: kind === 'revenue' ? 'income' : kind })).body.id;
      }
      const expense = await account(actor, 'EXP', 'expense'), revenue = await account(actor, 'REV', 'revenue');
      const inactive = await account(actor, 'INACTIVE', 'expense'), foreignAccount = await account(foreign, 'FOREIGN', 'expense');
      let cash;
      if (prefix) {
        cash = await account(actor, 'CASH', 'asset');
        await native.pool.query('UPDATE accounting.accounts SET is_active=false WHERE id=$1', [inactive]);
      } else sqlite.db().prepare('UPDATE account SET active=0 WHERE id=?').run(inactive);
      const setActive = async active => prefix
        ? native.pool.query('UPDATE accounting.accounts SET is_active=$2 WHERE id=$1', [expense, active])
        : sqlite.db().prepare('UPDATE account SET active=? WHERE id=?').run(Number(active), expense);
      const route = prefix + '/finance/transactions', strictRoute = prefix + '/finance/expenses';
      const body = { account_id: expense, amount: '100.01', currency: 'KRW', expense_date: '2026-09-08', expense_time: '12:34:56', merchant: 'Revision merchant', memo: 'Revision memo', no_receipt_reason: 'Lost receipt' };
      const oldBody = prefix ? { account_id: expense, amount: 100.01, entry_date: '2026-09-08', memo: 'Old memo' }
        : { kind: 'expense', amount_minor: 10001, occurred_on: '2026-09-08', account_id: expense, memo: 'Old memo' };
      async function upload() {
        const response = await fetch(base + route + '/receipt-uploads', { method: 'POST', headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId,
          'Content-Type': 'image/png', 'X-Upload-Name': 'revision.png' }, body: png, signal: AbortSignal.timeout(10000) });
        const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result.token;
      }
      const tables = prefix ? ['accounting.journal_entries', 'accounting.journal_lines', 'accounting.journal_entry_files', 'accounting.record_events', 'accounting.request_replays', 'files.objects', 'files.receipt_uploads', 'files.receipt_events']
        : ['transaction_record', 'transaction_evidence', 'finance_request_replay', 'file_object', 'receipt_upload', 'audit_event'];
      const snapshot = async () => prefix ? Promise.all(tables.map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows))
        : tables.map(table => sqlite.db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

      await t.test(`${name}: old POST rejects new/mixed fields without dropping metadata or consuming receipts`, async () => {
        const token = await upload(), before = await snapshot(), failures = [];
        const patches = [{ currency: 'USD' }, { expense_date: '2026-02-30' }, { merchant: 'New merchant' }, { expense_time: '12:34' },
          { receipt_tokens: [token] }, { no_receipt_reason: 'Lost' }, { ...body, currency: 'USD', expense_date: '2026-02-30', receipt_tokens: [token], no_receipt_reason: null },
          { ...body, receipt_tokens: [token], no_receipt_reason: null }];
        for (const patch of patches) {
          const result = await request(actor, route, { ...oldBody, ...patch }, null);
          if (result.status !== 400) failures.push({ patch, actual: result.status, id: result.body.id });
        }
        assert.deepEqual(failures, []);
        assert.deepEqual(await snapshot(), before);
        await request(actor, route, body, 400);
      });
      await t.test(`${name}: genuine old shape still works, replays and rejects changed old or new fields`, async () => {
        const key = randomUUID(), first = await request(actor, route, oldBody, 201, key), before = await snapshot();
        assert.equal(first.body.status, prefix ? 'confirmed' : 'draft'); assert.equal(first.body.counterparty, null);
        assert.deepEqual((await request(actor, route, oldBody, 201, key)).body, first.body);
        await request(actor, route, { ...oldBody, memo: 'Changed old memo' }, 409, key);
        await request(actor, route, { ...oldBody, merchant: 'Changed merchant', expense_date: '2026-09-09' }, 400, key);
        assert.deepEqual(await snapshot(), before);
        if (!prefix) await request(actor, route, oldBody, 201, null);
        else await request(actor, route, { ...oldBody, account_id: revenue }, 201);
      });
      await t.test(`${name}: strict flow remains usable and replay compares every consumed field`, async () => {
        const token = await upload(), input = { ...body, receipt_tokens: [token], no_receipt_reason: null }, key = randomUUID();
        const first = await request(actor, strictRoute, input, 201, key), before = await snapshot();
        assert.equal(first.body.status, 'confirmed'); assert.equal(first.body.amount, '100.01'); assert.equal(first.body.receipts.length, 1);
        assert.deepEqual((await request(actor, strictRoute, input, 201, key)).body, first.body);
        for (const patch of [{ merchant: 'Changed merchant' }, { expense_date: '2026-09-09' }, { expense_time: '12:35:56' }, { amount: '100.02' },
          { memo: 'Changed memo' }, { account_id: foreignAccount }, { budget_id: '123' }, { no_receipt_reason: 'Found later' }, { receipt_tokens: [], no_receipt_reason: 'Lost' },
          { receipt_tokens: ['A'.repeat(43)] }]) await request(actor, strictRoute, { ...input, ...patch }, 409, key);
        for (const patch of [{ currency: 'USD' }, { expense_date: '2026-02-30' }]) await request(actor, strictRoute, { ...input, ...patch }, 400, key);
        assert.deepEqual(await snapshot(), before);
        const download = await fetch(base + route + `/${first.body.id}/receipts/${first.body.receipts[0].file_id}`, {
          headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId }, signal: AbortSignal.timeout(10000) });
        assert.equal(download.status, 200); assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(png));
      });
      await t.test(`${name}: detail reload retains actual account, amount, version and scope even after account deactivation`, async () => {
        const created = (await request(actor, strictRoute, body)).body;
        await setActive(false);
        try {
          const detail = (await request(actor, `${route}/${created.id}`, undefined, 200)).body;
          assert.equal(detail.account_id, created.account_id); assert.equal(detail.account_id, expense);
          assert.equal(detail.amount, '100.01'); assert.equal(detail.expense_date, body.expense_date);
          assert.equal(detail.counterparty, body.merchant); assert.equal(detail.version, created.version);
          if (prefix) {
            assert.equal(detail.receipt_version, created.receipt_version);
            const actual = (await native.pool.query('SELECT id::text,account_id::text,debit::text,credit::text FROM accounting.journal_lines WHERE entry_id=$1 ORDER BY id', [created.id])).rows;
            assert.deepEqual(detail.lines.map(({ id, account_id, debit, credit }) => ({ id, account_id, debit, credit })), actual);
          }
          await request(foreign, `${route}/${created.id}`, undefined, 404);
        } finally { await setActive(true); }
      });
      await t.test(`${name}: options expose machine-readable type and only active selected-company accounts`, async () => {
        const items = (await request(actor, prefix + '/finance/accounts', undefined, 200)).body.items;
        const id = row => row.value ?? row.id, type = row => row.account_type ?? row.kind;
        assert.deepEqual(items.map(id).sort(), [expense, revenue].sort());
        assert.equal(type(items.find(row => id(row) === expense)), 'expense');
        assert.equal(type(items.find(row => id(row) === revenue)), prefix ? 'revenue' : 'income');
        if (prefix) for (const row of items) assert.equal(typeof row.label, 'string');
        const foreignItems = (await request(foreign, prefix + '/finance/accounts', undefined, 200)).body.items;
        assert.deepEqual(foreignItems.map(id), [foreignAccount]);
      });
      if (prefix) await t.test('PG: multi-account historical journal returns honest lines, not a guessed account', async () => {
        const second = await account(actor, 'EXP2', 'expense');
        const entry = (await native.pool.query("INSERT INTO accounting.journal_entries(company_id,entry_date,memo) VALUES($1,'2026-09-08','historical multi-account') RETURNING id", [actor.companyId])).rows[0].id;
        await native.pool.query('INSERT INTO accounting.journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,40,0),($1,$3,60.01,0),($1,$4,0,100.01)', [entry, expense, second, cash]);
        await native.pool.query('UPDATE accounting.journal_entries SET posted=true WHERE id=$1', [entry]);
        const detail = (await request(actor, `${route}/${entry}`, undefined, 200)).body;
        assert.equal(detail.account_id, null); assert.equal(detail.amount, '100.01');
        assert.deepEqual(detail.lines.filter(line => line.account_type === 'expense').map(line => line.account_id).sort(), [expense, second].sort());
      });
    }
  } finally {
    if (server) { const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); await closed; cleanup.serverClosed = true; }
    closeDb?.(); await closePgPool?.(); await native.close(); cleanup.nativeClosed = true;
    if (cleanup.native) cleanup.native.directoryRemoved = !existsSync(cleanup.native.directory);
    await writeFile(new URL('revision-native-scenarios.json', evidence), JSON.stringify(scenarios, null, 2));
    await writeFile(new URL('revision-native-cleanup.json', evidence), JSON.stringify(cleanup, null, 2));
  }
});
