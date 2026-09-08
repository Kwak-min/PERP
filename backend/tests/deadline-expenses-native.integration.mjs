import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'native-expenses');
const evidence = new URL('../../.omo/evidence/task-17-deadline-erp-redesign/', import.meta.url);
await mkdir(evidence, { recursive: true });
const native = await startDailyNativePostgres(), scenarios = [], traces = [], events = new EventEmitter();
let server, closePgPool, closeDb, passed = false;
const cleanup = {};
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  cleanup.native = (await native.pool.query("SELECT split_part(pg_read_file('postmaster.pid'),chr(10),1)::int AS pid,current_setting('port')::int AS port,current_setting('data_directory') AS directory,version() AS version")).rows[0];
  assert.match(cleanup.native.version, /PostgreSQL 18\./);
  for (const name of ['perp_additions_v12_deadline_expenses.sql', 'perp_additions_v12_deadline_expense_writer.sql']) {
    const ddl = await readFile(new URL('../../db/' + name, import.meta.url), 'utf8'); await native.pool.query(ddl); await native.pool.query(ddl);
  }
  const pg = await import('../src/config/pg.js'); closePgPool = pg.closePgPool;
  // 관측만 한다. 실제 pg client, SQL/locks/rollback/COMMIT은 그대로 실행한다.
  pg.pgPool.on('connect', client => {
    const query = client.query.bind(client); let current;
    client.query = (text, ...args) => {
      if (text === 'BEGIN') { current = []; traces.push(current); }
      current?.push(String(text));
      const result = query(text, ...args);
      if (text === 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE') events.emit('company-query');
      if (text === 'COMMIT' || text === 'ROLLBACK') current = undefined;
      return result;
    };
  });
  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/config/migrate.js');
  ({ closeDb } = await import('../src/config/db.js')); migrate();
  const app = createApp();
  server = createServer((req, res) => {
    if (req.headers['x-test-drop-response'] === 'yes') {
      // Controller의 res.json은 COMMIT 다음이다. 실제 HTTP socket을 여기서 끊는다.
      res.end = () => { res.destroy(); events.emit('response-dropped'); return res; };
    }
    app(req, res);
  });
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await listening;
  const base = `http://127.0.0.1:${server.address().port}/api/v1/pg`; cleanup.httpPort = server.address().port;
  async function request(actor, route, body, options = {}) {
    const response = await fetch(base + route, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json',
      ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}), 'Idempotency-Key': options.key ?? randomUUID(), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    scenarios.push({ route, status: response.status, body: route.startsWith('/auth') ? { authenticated: Boolean(result.token) } : result });
    if (options.status !== undefined) assert.equal(response.status, options.status, JSON.stringify(result));
    return { status: response.status, body: result };
  }
  async function company(name) {
    const signup = await request(null, '/auth/signup', { name, email: `${name}@example.invalid`, password: 'password-1234' }, { status: 201 });
    const actor = { token: signup.body.token, userId: signup.body.user.id };
    const created = await request(actor, '/companies', { name, modules: ['finance'] }, { status: 201 }); actor.orgId = created.body.org_id; actor.companyId = actor.orgId.slice(3); return actor;
  }
  const actor = await company('expense-native-a'), foreign = await company('expense-native-b');
  const account = (await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'EXP','Expense','expense') RETURNING id", [actor.companyId])).rows[0].id;
  await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'CASH','Cash','asset')", [actor.companyId]);
  const foreignAccount = (await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,'EXP','Expense','expense') RETURNING id", [foreign.companyId])).rows[0].id;
  const budget = (await native.pool.query("INSERT INTO accounting.budgets(company_id,name,account_id,amount,status) VALUES($1,'Budget',$2,100000,'active') RETURNING id", [actor.companyId, account])).rows[0].id;
  const foreignBudget = (await native.pool.query("INSERT INTO accounting.budgets(company_id,name,amount,status) VALUES($1,'Budget',100000,'active') RETURNING id", [foreign.companyId])).rows[0].id;
  const body = { account_id: account, budget_id: budget, amount: '100.01', expense_date: '2026-09-08', expense_time: '12:34:56', merchant: 'Native merchant', currency: 'KRW', no_receipt_reason: 'Lost receipt' };
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
  async function upload(who = actor) {
    const response = await fetch(base + '/finance/transactions/receipt-uploads', { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'X-Org-Id': who.orgId, 'Content-Type': 'image/png', 'X-Upload-Name': encodeURIComponent('native.png') }, body: png, signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result.token;
  }
  const tables = ['accounting.journal_entries', 'accounting.journal_lines', 'accounting.journal_entry_files', 'accounting.record_events', 'accounting.request_replays', 'files.objects', 'files.receipt_uploads', 'files.receipt_events'];
  const snapshot = () => Promise.all(tables.map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
  const token = await upload(), input = { ...body, no_receipt_reason: null, receipt_tokens: [token] }, key = randomUUID();
  const first = await request(actor, '/finance/expenses', input, { status: 201, key });
  assert.equal(first.body.amount, '100.01'); assert.equal(first.body.receipts.length, 1); assert.notEqual(first.body.receipt_version, '1');
  const entry = (await native.pool.query('SELECT *,xmin::text AS receipt_version FROM accounting.journal_entries WHERE id=$1', [first.body.id])).rows[0];
  assert.equal(first.body.receipt_version, entry.receipt_version); assert.equal(entry.posted, true); assert.equal(entry.input_currency, 'KRW');
  assert.equal(entry.counterparty, 'Native merchant'); assert.equal(entry.occurred_at.toISOString(), '2026-09-08T03:34:56.000Z');
  assert.deepEqual((await native.pool.query('SELECT SUM(debit)::text AS debit,SUM(credit)::text AS credit FROM accounting.journal_lines WHERE entry_id=$1', [entry.id])).rows[0], { debit: '100.01', credit: '100.01' });
  assert.equal((await request(actor, '/finance/summary', undefined, { status: 200 })).body.지출, '100.01');
  const beforeReplay = await snapshot();
  assert.deepEqual((await request(actor, '/finance/expenses', input, { status: 201, key })).body, first.body);
  await request(actor, '/finance/expenses', { ...input, amount: '100.02' }, { status: 409, key });
  assert.deepEqual(await snapshot(), beforeReplay);
  for (const patch of [{ account_id: foreignAccount }, { budget_id: foreignBudget }]) await request(actor, '/finance/expenses', { ...body, ...patch }, { status: 400 });
  const foreignToken = await upload(foreign), foreignBefore = await snapshot();
  await request(actor, '/finance/expenses', { ...body, receipt_tokens: [foreignToken] }, { status: 404 }); assert.deepEqual(await snapshot(), foreignBefore);

  // 실제 HTTP 응답 유실 뒤 동일 key는 이미 소비한 token을 다시 소비하지 않는다.
  const lossToken = await upload(), lossKey = randomUUID(), lossInput = { ...body, receipt_tokens: [lossToken] };
  const dropped = once(events, 'response-dropped', { signal: AbortSignal.timeout(10000) });
  const loss = assert.rejects(request(actor, '/finance/expenses', lossInput, { key: lossKey, headers: { 'X-Test-Drop-Response': 'yes' } }), /fetch failed/);
  await Promise.all([dropped, loss]);
  const afterLoss = await snapshot();
  const replay = await request(actor, '/finance/expenses', lossInput, { status: 201, key: lossKey }); assert.equal(replay.body.receipts.length, 1); assert.deepEqual(await snapshot(), afterLoss);
  scenarios.push({ responseLoss: 'socket destroyed after COMMIT; retry returns committed response', keyHash: hash(lossKey), id: replay.body.id });

  // 같은 key의 두 native transaction은 회사 lock부터 경쟁하고 단 한 번 게시한다.
  const raceKey = randomUUID(), raceToken = await upload(), raceInput = { ...body, receipt_tokens: [raceToken] };
  const raced = await Promise.all([request(actor, '/finance/expenses', raceInput, { status: 201, key: raceKey }), request(actor, '/finance/expenses', raceInput, { status: 201, key: raceKey })]);
  assert.deepEqual(raced[0], raced[1]);
  assert.equal((await native.pool.query('SELECT COUNT(*)::int AS n FROM accounting.request_replays WHERE request_key=$1', [raceKey])).rows[0].n, 1);
  const singleToken = await upload();
  const tokenRace = await Promise.all([request(actor, '/finance/expenses', { ...body, receipt_tokens: [singleToken] }), request(actor, '/finance/expenses', { ...body, receipt_tokens: [singleToken] })]);
  assert.deepEqual(tokenRace.map(result => result.status).sort(), [201, 404]);
  scenarios.push({ nativeRace: 'same key returns one journal; different keys racing same token have one winner', sameKeyJournal: raced[0].body.id });

  // 실제 trigger 실패: replay 예약/부모/각 lines/게시/link/파일/소비/audit/응답까지 전부 rollback.
  const failToken = await upload(), failInput = { ...body, receipt_tokens: [failToken] };
  const seams = [['accounting.request_replays', 'INSERT', 'true'], ['accounting.journal_entries', 'INSERT', 'true'],
    ['accounting.journal_lines', 'INSERT', 'NEW.debit>0'], ['accounting.journal_lines', 'INSERT', 'NEW.credit>0'], ['accounting.journal_entries', 'UPDATE', 'NEW.posted'],
    ['files.objects', 'INSERT', 'true'], ['accounting.journal_entry_files', 'INSERT', 'true'], ['files.receipt_uploads', 'UPDATE', "NEW.state='consumed'"],
    ['files.receipt_events', 'INSERT', 'true'], ['accounting.record_events', 'INSERT', 'true'], ['accounting.request_replays', 'UPDATE', 'true']];
  for (const [table, operation, condition] of seams) {
    const before = await snapshot(), failedKey = randomUUID();
    await native.pool.query(`CREATE FUNCTION accounting.t17_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 't17 injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER t17_failure BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION accounting.t17_failure()`);
    try { await request(actor, '/finance/expenses', failInput, { status: 500, key: failedKey }); }
    finally { await native.pool.query(`DROP TRIGGER t17_failure ON ${table}; DROP FUNCTION accounting.t17_failure()`); }
    assert.deepEqual(await snapshot(), before, `${table} ${operation} left partial state`);
    scenarios.push({ injected: { table, operation, condition }, rollback: 'all domain/file/link/token/audit/replay state unchanged' });
  }
  await request(actor, '/finance/expenses', failInput, { status: 201 });

  const appendToken = await upload(), appendKey = randomUUID();
  const appendBody = { expected_version: first.body.receipt_version, receipt_tokens: [appendToken] };
  await request(actor, `/finance/transactions/${entry.id}/receipts`, appendBody, { status: 200, key: appendKey });
  assert.deepEqual((await native.pool.query('SELECT *,xmin::text AS receipt_version FROM accounting.journal_entries WHERE id=$1', [entry.id])).rows[0], entry);
  await request(actor, `/finance/transactions/${entry.id}/receipts`, appendBody, { status: 200, key: appendKey });
  await assert.rejects(native.pool.query("UPDATE accounting.journal_entries SET memo='mutated' WHERE id=$1", [entry.id]), { code: '23514' });
  await assert.rejects(native.pool.query('DELETE FROM accounting.journal_entries WHERE id=$1', [entry.id]), { code: '23514' });
  await assert.rejects(native.pool.query('DELETE FROM accounting.journal_entry_files WHERE entry_id=$1', [entry.id]), { code: '23514' });
  const login = await request(null, '/auth/login', { email: 'expense-native-a@example.invalid', password: 'password-1234' }, { status: 200 });
  const downloaded = await fetch(base + `/finance/transactions/${entry.id}/receipts/${first.body.receipts[0].file_id}`, { headers: { Authorization: `Bearer ${login.body.token}`, 'X-Org-Id': actor.orgId }, signal: AbortSignal.timeout(10000) });
  assert.equal(downloaded.status, 200); assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), hash(png));
  assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);

  // 회사 lock에 먼저 대기한 요청은 middleware의 옛 grant가 아니라 revoke COMMIT 뒤 현재 grant를 읽는다.
  const revoker = await native.pool.connect();
  try {
    await revoker.query('BEGIN'); await revoker.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [actor.companyId]);
    const queued = once(events, 'company-query', { signal: AbortSignal.timeout(10000) });
    const pendingReplay = request(actor, '/finance/expenses', input, { status: 403, key });
    await queued;
    await revoker.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND p.code='transaction.write'", [actor.companyId]);
    await revoker.query('COMMIT'); await pendingReplay;
    scenarios.push({ freshReplayAuth: 'HTTP middleware passes; blocked company query observes revoke before replay lookup', status: 403 });
  } catch (error) { await revoker.query('ROLLBACK'); throw error; }
  finally { revoker.release(); }

  const writes = traces.filter(trace => trace.some(sql => /accounting\.request_replays/.test(sql)));
  assert.ok(writes.length > 10);
  for (const trace of writes) {
    assert.equal(trace[0], 'BEGIN'); assert.equal(trace[1], 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE');
    assert.equal(trace.filter(sql => sql === 'COMMIT' || sql === 'ROLLBACK').length, 1);
  }
  await writeFile(new URL('native-transaction-traces.json', evidence), JSON.stringify(writes, null, 2));
  passed = true;
  console.log(JSON.stringify({ passed, engine: cleanup.native.version, scenarios: scenarios.length, verifiedTransactionTraces: writes.length }));
} finally {
  if (server) { const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); await closed; cleanup.serverClosed = true; }
  closeDb?.(); await closePgPool?.(); await native.close(); cleanup.nativeClosed = true;
  if (cleanup.native) cleanup.native.directoryRemoved = !existsSync(cleanup.native.directory);
  await writeFile(new URL('native-scenario.json', evidence), JSON.stringify({ passed, scenarios }, null, 2));
  await writeFile(new URL('native-cleanup.json', evidence), JSON.stringify(cleanup, null, 2));
}
