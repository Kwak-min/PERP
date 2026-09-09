import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { startTestServer, createOwnerOrg } from './http.js';

export async function firstMoneyScenarios(native = null) {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'first-money-receipts');
  const server = await startTestServer(), pg = Boolean(native), prefix = pg ? '/pg' : '';
  const { db } = await import('../src/config/db.js');
  async function request(actor, route, body, status = 200, key, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(server.baseUrl + prefix + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(result)}`); return result;
  }
  async function company() {
    if (!pg) return createOwnerOrg(server.baseUrl, ['finance']);
    const signup = await request(null, '/auth/signup', { name: '첫 기록 관리자', email: `${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
    const actor = { token: signup.token, userId: String(signup.user.id) };
    actor.orgId = (await request(actor, '/companies', { name: '빈 돈 관리 공간', modules: ['finance'] }, 201)).org_id; return actor;
  }
  const tables = pg ? ['accounting.accounts', 'accounting.journal_entries', 'accounting.journal_lines', 'accounting.record_events', 'accounting.request_replays', 'files.objects', 'files.receipt_uploads', 'accounting.journal_entry_files'] : ['account', 'transaction_record', 'audit_event', 'finance_request_replay', 'file_object', 'receipt_upload', 'transaction_evidence'];
  const snapshot = async () => pg ? Promise.all(tables.map(async table => (await native.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)) : tables.map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  try {
    const actor = await company(), foreign = await company();
    // 첫 사용 증명: 일반 생성 API만 호출하며 계정/거래 픽스처를 심지 않는다.
    const before = await snapshot();
    assert.deepEqual(await request(actor, '/finance/setup'), { ready: false, can_initialize: true, missing: pg ? ['cash', 'income', 'expense'] : ['income', 'expense'] });
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await request(actor, '/finance/setup', {}), { ready: true, can_initialize: true, missing: [] });
    const initialized = await snapshot();
    await Promise.all([request(actor, '/finance/setup', {}), request(actor, '/finance/setup', {})]);
    assert.deepEqual(await snapshot(), initialized);
    await request(actor, '/finance/setup', { demo: true }, 400);
    const accounts = (await request(actor, '/finance/accounts')).items;
    const income = accounts.find(a => (a.kind ?? a.account_type) === (pg ? 'revenue' : 'income'));
    const expense = accounts.find(a => (a.kind ?? a.account_type) === 'expense');
    const incomeId = income.id ?? income.value, expenseId = expense.id ?? expense.value;
    assert.equal((await request(actor, '/finance/transactions')).items.length, 0);
    const payload = { amount: '100.01', currency: 'KRW', income_date: '2026-09-09', payer: '첫 입금자', account_id: incomeId, memo: '첫 수입' }, key = randomUUID();
    const saved = await request(actor, '/finance/incomes', payload, 201, key);
    assert.equal(saved.kind, 'income'); assert.equal(saved.amount, '100.01'); assert.equal(saved.income_date, payload.income_date); assert.equal(saved.payer, payload.payer); assert.equal(saved.status, 'confirmed');
    const posted = await snapshot();
    assert.deepEqual(await request(actor, '/finance/incomes', payload, 201, key), saved);
    await request(actor, '/finance/incomes', { ...payload, amount: '100.02' }, 409, key);
    assert.deepEqual(await snapshot(), posted);
    for (const patch of [{ amount: 1 }, { amount: '1.001' }, { amount: '0' }, { amount: '-1' }, { currency: 'USD' }, { income_date: '2026-02-30' }, { income_date: '0000-01-01' }, { payer: ' ' }, { account_id: expenseId }, { project_id: 'unowned-project' }, { receipt_tokens: [] }, { kind: 'expense' }]) await request(actor, '/finance/incomes', { ...payload, ...patch }, 400, randomUUID());
    await request(actor, '/finance/incomes', payload, 400);
    await request(foreign, '/finance/incomes', payload, pg ? 400 : 404, randomUUID());
    assert.deepEqual(await snapshot(), posted);
    const expensePayload = { amount: '40.02', currency: 'KRW', expense_date: payload.income_date, merchant: '첫 사용처', account_id: expenseId, memo: '첫 지출' };
    await request(actor, '/finance/expenses', expensePayload, 400, randomUUID());
    await request(actor, '/finance/expenses', { ...expensePayload, account_id: incomeId, no_receipt_reason: '미발급' }, 400, randomUUID());
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
    const upload = await fetch(server.baseUrl + prefix + '/finance/transactions/receipt-uploads', { method: 'POST', headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'image/png', 'X-Upload-Name': 'first.png' }, body: png, signal: AbortSignal.timeout(10000) });
    assert.equal(upload.status, 201); const receipt = await upload.json();
    const paid = await request(actor, '/finance/expenses', { ...expensePayload, receipt_tokens: [receipt.token] }, 201, randomUUID());
    assert.equal(paid.amount, '40.02'); assert.equal(paid.receipts.length, 1);
    const detail = await request(actor, `/finance/transactions/${saved.id}`); assert.equal(detail.amount, '100.01');
    if (pg) {
      assert.deepEqual(await request(actor, '/finance/summary'), { 수입: '100.01', 지출: '40.02', 잔액: '59.99' });
      const listed = (await request(actor, '/finance/transactions')).items;
      assert.equal(listed.find(row => String(row.__id) === saved.id).kind, 'income');
      await assert.rejects(native.pool.query("UPDATE accounting.journal_entries SET memo='changed' WHERE id=$1", [saved.id]), /posted/);
      // 첫 사용 증명 이후에만 과거 복합 전표를 구성한다. 방향을 단일 수입/지출로 합성하지 않는다.
      const cash = (await native.pool.query("SELECT id FROM accounting.accounts WHERE company_id=$1 AND account_type='asset'", [actor.orgId.slice(3)])).rows[0];
      const historical = (await native.pool.query("INSERT INTO accounting.journal_entries(company_id,entry_date,memo,created_by) VALUES($1,'2020-01-01','HISTORICAL_COMPOUND',$2) RETURNING id", [actor.orgId.slice(3), actor.userId])).rows[0];
      await native.pool.query('INSERT INTO accounting.journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,59.99,0),($1,$3,40.02,0),($1,$4,0,100.01)', [historical.id, cash.id, expenseId, incomeId]);
      await native.pool.query('UPDATE accounting.journal_entries SET posted=true WHERE id=$1', [historical.id]);
      const historyBefore = await snapshot();
      const historicalRow = (await request(actor, '/finance/transactions')).items.find(row => String(row.__id) === String(historical.id));
      assert.equal(historicalRow.kind, 'journal'); assert.equal(historicalRow.income_amount, '100.01'); assert.equal(historicalRow.expense_amount, '40.02'); assert.equal(historicalRow.차변, '100.01'); assert.equal(historicalRow.대변, '100.01'); assert.equal(historicalRow.input_currency, null);
      const historicalDetail = await request(actor, `/finance/transactions/${historical.id}`); assert.equal(historicalDetail.account_id, null); assert.equal(historicalDetail.lines.length, 3);
      assert.deepEqual(await snapshot(), historyBefore);
    } else {
      assert.equal(db().prepare('SELECT amount_minor FROM transaction_record WHERE id=?').get(saved.id).amount_minor, 10001);
      await request(actor, `/finance/transactions/${saved.id}`, { memo: 'changed' }, 409, undefined, 'PATCH');
    }
    // 계정 일부만 있는 기존 공간: 충돌 코드와 비활성 계정을 변경하지 않고 누락 방향만 추가한다.
    if (pg) await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type,is_active) VALUES($1,'4100','보존 계정','expense',true),($1,'5100','비활성 보존','expense',false)", [foreign.orgId.slice(3)]);
    else for (const item of [{ code: '4100', name: '보존 계정', kind: 'expense' }, { code: '5100', name: '비활성 보존', kind: 'expense' }]) await request(foreign, '/finance/accounts', item, 201);
    const preserved = (await request(foreign, '/finance/accounts')).items;
    const rawAccounts = async who => pg ? (await native.pool.query('SELECT * FROM accounting.accounts WHERE company_id=$1 ORDER BY id', [who.orgId.slice(3)])).rows : db().prepare('SELECT * FROM account WHERE org_id=? ORDER BY id').all(who.orgId);
    const originalAccounts = await rawAccounts(foreign);
    const partial = await request(foreign, '/finance/setup'); assert.ok(!partial.missing.includes('expense')); assert.ok(partial.missing.includes('income'));
    await request(foreign, '/finance/setup', {});
    const afterAccounts = (await request(foreign, '/finance/accounts')).items;
    for (const row of preserved) assert.ok(afterAccounts.some(value => JSON.stringify(value) === JSON.stringify(row)));
    const resultingAccounts = await rawAccounts(foreign);
    for (const row of originalAccounts) assert.deepEqual(resultingAccounts.find(value => value.id === row.id), row);
    // 현재 권한을 다시 확인한다. 회계 입력 권한만으로는 초기화할 수 없다.
    if (pg) await native.pool.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND p.code='organization.settings'", [foreign.orgId.slice(3)]);
    else db().prepare("UPDATE membership SET roles='treasurer' WHERE user_id=? AND org_id=?").run(foreign.userId, foreign.orgId);
    const deniedBefore = await snapshot();
    assert.equal((await request(foreign, '/finance/setup')).can_initialize, false);
    await request(foreign, '/finance/setup', {}, 403); assert.deepEqual(await snapshot(), deniedBefore);
    // 초기화 역시 계정/감사가 같은 트랜잭션이며, 실패한 빈 공간에 다시 실행할 수 있다.
    const empty = await company();
    for (const table of pg ? ['accounting.accounts', 'accounting.record_events'] : ['account', 'audit_event']) {
      const stable = await snapshot();
      if (pg) await native.pool.query(`CREATE FUNCTION accounting.first_setup_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'first setup injected failure'; END $$; CREATE TRIGGER first_setup_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION accounting.first_setup_fail()`);
      else db().exec(`CREATE TRIGGER first_setup_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'first setup injected failure'); END`);
      try { await request(empty, '/finance/setup', {}, 500); }
      finally { if (pg) await native.pool.query(`DROP TRIGGER first_setup_fail ON ${table}; DROP FUNCTION accounting.first_setup_fail()`); else db().exec('DROP TRIGGER first_setup_fail'); }
      assert.deepEqual(await snapshot(), stable);
    }
    if (!pg) db().prepare("UPDATE organization SET type='lab' WHERE id=?").run(empty.orgId);
    const racedSetup = await Promise.all([request(empty, '/finance/setup', {}), request(empty, '/finance/setup', {})]);
    assert.ok(racedSetup.every(value => value.ready)); assert.equal((await rawAccounts(empty)).length, pg ? 3 : 2);
    if (!pg) assert.deepEqual((await rawAccounts(empty)).map(row => row.code).sort(), ['4200', '5300']);
    // 명시 메뉴/동작 권한 및 모듈 해제는 준비/입력/재생 모두 차단한다.
    if (pg) {
      await native.pool.query("INSERT INTO org.permissions(code,module,description) VALUES('menu.configured','menu','explicit menus') ON CONFLICT DO NOTHING");
      await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.company_id=$1 AND p.code='menu.configured' ON CONFLICT DO NOTHING", [foreign.orgId.slice(3)]);
      await native.pool.query("DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND p.code='menu.finance'", [foreign.orgId.slice(3)]);
    }
    else db().prepare("UPDATE membership SET roles='member' WHERE user_id=? AND org_id=?").run(foreign.userId, foreign.orgId);
    const noMenuBefore = await snapshot();
    await request(foreign, '/finance/setup', undefined, 403); await request(foreign, '/finance/setup', {}, 403); await request(foreign, '/finance/incomes', payload, 403, randomUUID());
    assert.deepEqual(await snapshot(), noMenuBefore);
    if (pg) await native.pool.query("DELETE FROM org.company_modules WHERE company_id=$1 AND module_key='finance'", [empty.orgId.slice(3)]);
    else db().prepare("UPDATE organization SET modules='tasks' WHERE id=?").run(empty.orgId);
    const disabled = await snapshot(); await request(empty, '/finance/setup', undefined, 403); await request(empty, '/finance/setup', {}, 403); await request(empty, '/finance/incomes', payload, 403, randomUUID()); assert.deepEqual(await snapshot(), disabled);
    // 최대 소수 금액도 문자열로 왕복하며 SQLite 안전 정수 한계를 넘기지 않는다.
    const maximum = pg ? '9999999999999999.99' : '90071992547409.91';
    assert.equal((await request(actor, '/finance/incomes', { ...payload, amount: maximum }, 201, randomUUID())).amount, maximum);
    const maxBefore = await snapshot(); await request(actor, '/finance/incomes', { ...payload, amount: pg ? '10000000000000000.00' : '90071992547409.92' }, 400, randomUUID()); assert.deepEqual(await snapshot(), maxBefore);
    const incomeRaceKey = randomUUID(), incomeRace = await Promise.all([request(actor, '/finance/incomes', payload, 201, incomeRaceKey), request(actor, '/finance/incomes', payload, 201, incomeRaceKey)]); assert.deepEqual(incomeRace[0], incomeRace[1]);
    // 감사/재생 실패도 원장과 함께 되돌린다. 동일 키 재시도는 한 번만 기록한다.
    for (const table of pg ? ['accounting.journal_entries', 'accounting.journal_lines', 'accounting.record_events', 'accounting.request_replays'] : ['transaction_record', 'audit_event', 'finance_request_replay']) {
      const stable = await snapshot(), retryKey = randomUUID();
      if (pg) await native.pool.query(`CREATE FUNCTION accounting.first_money_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'first money injected failure'; END $$; CREATE TRIGGER first_money_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION accounting.first_money_fail()`);
      else db().exec(`CREATE TRIGGER first_money_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'first money injected failure'); END`);
      try { await request(actor, '/finance/incomes', payload, 500, retryKey); }
      finally { if (pg) await native.pool.query(`DROP TRIGGER first_money_fail ON ${table}; DROP FUNCTION accounting.first_money_fail()`); else db().exec('DROP TRIGGER first_money_fail'); }
      assert.deepEqual(await snapshot(), stable);
      const retried = await request(actor, '/finance/incomes', payload, 201, retryKey);
      assert.deepEqual(await request(actor, '/finance/incomes', payload, 201, retryKey), retried);
    }
    console.log(JSON.stringify({ engine: pg ? 'native PostgreSQL' : 'SQLite', firstUse: 'ordinary organization -> explicit setup -> income 100.01 -> receipt expense 40.02 -> net 59.99', setup: 'empty/partial/repeated/denied', income: 'exact/scoped/strict/atomic/replayed/immutable', ids: { income: saved.id, expense: paid.id } }));
  } finally { await server.close(); if (pg) await (await import('../src/config/pg.js')).closePgPool(); }
}
