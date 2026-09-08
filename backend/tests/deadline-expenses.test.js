import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { startTestServer, createOwnerOrg, api } from './http.js';
import { installFinanceFixture } from './pg-daily-finance-fixture.js';

const evidence = new URL('../../.omo/evidence/task-17-deadline-erp-redesign/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');

test('strict expense adapters post exact existing ledgers and preserve compatible transaction requests', { timeout: 120000 }, async t => {
  process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'expense-receipts');
  const server = await startTestServer(), scenarios = [];
  let fixture;
  try {
    const { db } = await import('../src/config/db.js');
    const actor = await createOwnerOrg(server.baseUrl, ['finance']);
    const foreign = await createOwnerOrg(server.baseUrl, ['finance']);
    const account = await api(server.baseUrl, '/finance/accounts', { ...actor, method: 'POST', body: { code: 'EXP', name: 'Expense', kind: 'expense' } });
    const foreignAccount = await api(server.baseUrl, '/finance/accounts', { ...foreign, method: 'POST', body: { code: 'EXP', name: 'Expense', kind: 'expense' } });
    const foreignBudget = await api(server.baseUrl, '/finance/budgets', { ...foreign, method: 'POST', body: { name: 'Foreign', amount_minor: 100000 } });
    const budget = await api(server.baseUrl, '/finance/budgets', { ...actor, method: 'POST', body: { name: 'Own', account_id: account.body.id, amount_minor: 10000000 } });
    const body = { account_id: account.body.id, budget_id: budget.body.id, amount: '100.01', expense_date: '2026-09-08', expense_time: '12:34:56', merchant: 'Merchant', currency: 'KRW', no_receipt_reason: 'Lost receipt' };
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
    fixture = await installFinanceFixture();
    const pgAccount = (await fixture.db.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES(1,'500','Expense','expense') RETURNING id")).rows[0].id;
    const pgForeignAccount = (await fixture.db.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES(2,'500','Expense','expense') RETURNING id")).rows[0].id;
    const pgBudget = (await fixture.db.query("INSERT INTO accounting.budgets(company_id,name,account_id,amount,status) VALUES(1,'Expense budget',$1,100000,'active') RETURNING id", [pgAccount])).rows[0].id;
    const pgForeignBudget = (await fixture.db.query("INSERT INTO accounting.budgets(company_id,name,amount,status) VALUES(2,'Foreign budget',100000,'active') RETURNING id")).rows[0].id;
    const legacyTables = ['transaction_record', 'transaction_evidence', 'file_object', 'receipt_upload', 'audit_event', 'finance_request_replay'];
    const pgTables = ['accounting.journal_entries', 'accounting.journal_lines', 'accounting.journal_entry_files', 'files.objects', 'files.receipt_uploads', 'files.receipt_events', 'accounting.record_events', 'accounting.request_replays'];
    const contexts = [
      { name: 'legacy', prefix: '', actor, foreign, body, foreignAccount: foreignAccount.body.id, foreignBudget: foreignBudget.body.id,
        snapshot: async () => legacyTables.map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) },
      { name: 'PG', prefix: '/pg', actor: fixture.actor(), foreign: fixture.actor(2), body: { ...body, account_id: String(pgAccount), budget_id: String(pgBudget) }, foreignAccount: String(pgForeignAccount), foreignBudget: String(pgForeignBudget),
        snapshot: async () => Promise.all(pgTables.map(async table => (await fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)) },
    ];
    for (const context of contexts) {
      const request = async (route, payload, status = 201, key = randomUUID(), who = context.actor, method = 'POST') => {
        const result = await api(server.baseUrl, context.prefix + route, { ...who, method, body: payload, headers: key === null ? {} : { 'Idempotency-Key': key } });
        assert.equal(result.status, status, `${context.name} ${route}: ${JSON.stringify(result.body)}`);
        scenarios.push({ source: context.name, route, method, status: result.status, body: result.body }); return result.body;
      };
      const upload = async (who = context.actor) => {
        const response = await fetch(server.baseUrl + context.prefix + '/finance/transactions/receipt-uploads', { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'X-Org-Id': who.orgId, 'Content-Type': 'image/png', 'X-Upload-Name': encodeURIComponent('receipt.png') }, body: png, signal: AbortSignal.timeout(10000) });
        const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result.token;
      };
      let created;
      await t.test(`${context.name}: exact 100.01, timestamp, metadata and one confirmed existing ledger`, async () => {
        created = await request('/finance/expenses', context.body);
        assert.equal(created.amount, '100.01'); assert.equal(created.status, 'confirmed');
        assert.equal(created.counterparty, 'Merchant'); assert.equal(created.occurred_at, '2026-09-08T03:34:56.000Z');
        if (context.name === 'legacy') assert.equal(created.amount_minor, 10001);
        else {
          assert.deepEqual((await fixture.db.query('SELECT posted,counterparty,input_currency FROM accounting.journal_entries WHERE id=$1', [created.id])).rows[0], { posted: true, counterparty: 'Merchant', input_currency: 'KRW' });
          assert.deepEqual((await fixture.db.query('SELECT SUM(debit)::text AS debit,SUM(credit)::text AS credit FROM accounting.journal_lines WHERE entry_id=$1', [created.id])).rows[0], { debit: '100.01', credit: '100.01' });
        }
        const detail = await request(`/finance/transactions/${created.id}`, undefined, 200, null, context.actor, 'GET');
        assert.equal(detail.amount, '100.01'); assert.equal(detail.counterparty, 'Merchant');
        await request(`/finance/transactions/${created.id}`, undefined, 404, null, context.foreign, 'GET');
      });
      await t.test(`${context.name}: strict new input rejects precision, non-KRW, invalid dates/time, missing reason and arbitrary adoption`, async () => {
        const before = await context.snapshot();
        for (const patch of [{ amount: 100.01 }, { amount: '0' }, { amount: '-1' }, { amount: '1.001' }, { amount: '10000000000000000.00' }, { currency: 'USD' }, { expense_date: '2026-02-30' }, { expense_date: '0000-01-01' }, { expense_time: '24:00' }, { merchant: ' ' }, { merchant: 'x'.repeat(201) }, { no_receipt_reason: null }, { no_receipt_reason: '' }, { file_id: '1' }, { receipt_tokens: ['https://example.invalid/file'] }, { amount_minor: 10001 }]) {
          await request('/finance/expenses', { ...context.body, ...patch }, 400);
        }
        await request('/finance/expenses', context.body, 400, null);
        assert.deepEqual(await context.snapshot(), before);
      });
      await t.test(`${context.name}: foreign/inactive account and budget reject without writes`, async () => {
        const before = await context.snapshot();
        await request('/finance/expenses', { ...context.body, account_id: context.foreignAccount }, context.name === 'PG' ? 400 : 404);
        await request('/finance/expenses', { ...context.body, budget_id: context.foreignBudget }, context.name === 'PG' ? 400 : 404);
        if (context.name === 'PG') {
          await fixture.db.query('UPDATE accounting.accounts SET is_active=false WHERE id=$1', [pgAccount]);
          try { await request('/finance/expenses', context.body, 400); } finally { await fixture.db.query('UPDATE accounting.accounts SET is_active=true WHERE id=$1', [pgAccount]); }
          await fixture.db.query("UPDATE accounting.budgets SET status='closed' WHERE id=$1", [pgBudget]);
          try { await request('/finance/expenses', context.body, 400); } finally { await fixture.db.query("UPDATE accounting.budgets SET status='active' WHERE id=$1", [pgBudget]); }
          await request('/finance/expenses', { ...context.body, account_id: '2', budget_id: null }, 400);
        } else {
          db().prepare('UPDATE account SET active=0 WHERE id=?').run(account.body.id);
          try { await request('/finance/expenses', context.body, 400); } finally { db().prepare('UPDATE account SET active=1 WHERE id=?').run(account.body.id); }
          db().prepare("UPDATE budget SET status='closed' WHERE id=?").run(budget.body.id);
          try { await request('/finance/expenses', context.body, 400); } finally { db().prepare("UPDATE budget SET status='approved' WHERE id=?").run(budget.body.id); }
        }
        assert.deepEqual(await context.snapshot(), before);
      });
      await t.test(`${context.name}: lost response replay, concurrent same key and different payload conflict`, async () => {
        const key = randomUUID(), first = await request('/finance/expenses', context.body, 201, key), before = await context.snapshot();
        const replays = await Promise.all([request('/finance/expenses', context.body, 201, key), request('/finance/expenses', context.body, 201, key)]);
        assert.deepEqual(replays, [first, first]);
        await request('/finance/expenses', { ...context.body, amount: '100.02' }, 409, key);
        assert.deepEqual(await context.snapshot(), before);
        const freshKey = randomUUID();
        const fresh = await Promise.all([request('/finance/expenses', context.body, 201, freshKey), request('/finance/expenses', context.body, 201, freshKey)]);
        assert.equal(fresh[0].id, fresh[1].id);
      });
      await t.test(`${context.name}: receipt creation/append are audited, scoped and leave the original immutable`, async () => {
        const token = await upload(), foreignToken = await upload(context.foreign);
        const input = { ...context.body, no_receipt_reason: null, receipt_tokens: [token] }, key = randomUUID();
        const before = await context.snapshot();
        await request('/finance/expenses', { ...input, receipt_tokens: [foreignToken] }, 404);
        assert.deepEqual(await context.snapshot(), before);
        const receiptEntry = await request('/finance/expenses', input, 201, key);
        assert.equal(receiptEntry.receipts.length, 1);
        assert.deepEqual(await request('/finance/expenses', input, 201, key), receiptEntry);
        const original = await request(`/finance/transactions/${receiptEntry.id}`, undefined, 200, null, context.actor, 'GET');
        const appendToken = await upload(), appendKey = randomUUID();
        const appendBody = { expected_version: context.name === 'PG' ? original.receipt_version : original.version, receipt_tokens: [appendToken] };
        const appended = await request(`/finance/transactions/${receiptEntry.id}/receipts`, appendBody, 200, appendKey);
        assert.deepEqual(await request(`/finance/transactions/${receiptEntry.id}/receipts`, appendBody, 200, appendKey), appended);
        await request(`/finance/transactions/${receiptEntry.id}/receipts`, { ...appendBody, expected_version: context.name === 'PG' ? '0' : 999 }, 409);
        const detail = await request(`/finance/transactions/${receiptEntry.id}`, undefined, 200, null, context.actor, 'GET');
        assert.equal(detail.amount, original.amount); assert.equal(detail.version, original.version); assert.equal(detail.receipts.length, 2);
        const download = await fetch(server.baseUrl + context.prefix + `/finance/transactions/${receiptEntry.id}/receipts/${receiptEntry.receipts[0].file_id}`, { headers: { Authorization: `Bearer ${context.actor.token}`, 'X-Org-Id': context.actor.orgId }, signal: AbortSignal.timeout(10000) });
        assert.equal(download.status, 200); assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(png));
        if (context.name === 'PG') {
          await assert.rejects(fixture.db.query('UPDATE accounting.journal_entries SET memo=$1 WHERE id=$2', ['changed', receiptEntry.id]), /posted/);
          await assert.rejects(fixture.db.query('DELETE FROM accounting.journal_lines WHERE entry_id=$1', [receiptEntry.id]), /posted/);
          assert.equal((await fixture.db.query('SELECT COUNT(*)::int AS n FROM files.receipt_events WHERE parent_id=$1', [receiptEntry.id])).rows[0].n, 2);
        } else {
          await request(`/finance/transactions/${receiptEntry.id}`, { memo: 'changed' }, 409, null, context.actor, 'PATCH');
          assert.throws(() => db().prepare('DELETE FROM transaction_record WHERE id=?').run(receiptEntry.id), /immutable/);
          assert.equal(db().prepare("SELECT COUNT(*) AS n FROM audit_event WHERE resource_id=? AND action='receipt.attached'").get(receiptEntry.id).n, 2);
          const listed = await request('/finance/transactions', undefined, 200, null, context.actor, 'GET');
          assert.equal(listed.items.find(row => row.id === receiptEntry.id).evidence_count, 2);
        }
      });
      await t.test(`${context.name}: each domain/link/audit/replay write failure has zero partial state and retry works`, async () => {
        const token = await upload(), input = { ...context.body, receipt_tokens: [token] };
        if (context.name === 'PG') {
          fixture.inject(); await request('/finance/expenses', input); const writes = fixture.writes; assert.ok(writes >= 10);
          const pendingToken = await upload(), pending = { ...input, receipt_tokens: [pendingToken] };
          for (let index = 1; index <= writes; index++) {
            const before = await context.snapshot(); fixture.inject(index);
            await request('/finance/expenses', pending, 500); fixture.inject();
            assert.deepEqual(await context.snapshot(), before, `PG write ${index} left partial state`);
          }
          await request('/finance/expenses', pending);
        } else {
          for (const [table, operation] of [['transaction_record', 'INSERT'], ['file_object', 'INSERT'], ['transaction_evidence', 'INSERT'], ['receipt_upload', 'UPDATE'], ['audit_event', 'INSERT'], ['finance_request_replay', 'INSERT']]) {
            const before = await context.snapshot();
            db().exec(`CREATE TRIGGER expense_test_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'expense injected failure'); END`);
            try { await request('/finance/expenses', input, 500); }
            finally { db().exec('DROP TRIGGER expense_test_failure'); }
            assert.deepEqual(await context.snapshot(), before, `${table} left partial state`);
          }
          await request('/finance/expenses', input);
        }
      });
      await t.test(`${context.name}: compatible old POST uses same atomic writer and does not fabricate metadata`, async () => {
        const payload = context.name === 'PG' ? { account_id: context.body.account_id, amount: 100.01, entry_date: '2026-09-08' } : { kind: 'expense', amount_minor: 10001, occurred_on: '2026-09-08' };
        const old = await request('/finance/transactions', payload);
        assert.equal(old.status, context.name === 'PG' ? 'confirmed' : 'draft'); assert.equal(old.counterparty, null); assert.equal(old.occurred_at, null);
        const absentTime = await request('/finance/expenses', { ...context.body, expense_time: undefined }); assert.equal(absentTime.occurred_at, null);
      });
    }
    await t.test('legacy safe minor bound accepts exact maximum and rejects overflow without rounding', async () => {
      const create = amount => api(server.baseUrl, '/finance/expenses', { ...actor, method: 'POST', body: { ...body, budget_id: null, amount }, headers: { 'Idempotency-Key': randomUUID() } });
      const max = await create('90071992547409.91'); assert.equal(max.status, 201); assert.equal(max.body.amount_minor, Number.MAX_SAFE_INTEGER); assert.equal(max.body.amount, '90071992547409.91');
      assert.equal((await create('90071992547409.92')).status, 400);
    });
  } finally {
    await server.close(); await fixture?.close();
    await mkdir(evidence, { recursive: true });
    await writeFile(new URL('scenario.json', evidence), JSON.stringify({ scenarios }, null, 2));
    await writeFile(new URL('cleanup.json', evidence), JSON.stringify({ serverClosed: true, fixtureClosed: Boolean(fixture), uploadsOwnedByIsolatedRunner: true }, null, 2));
  }
});
