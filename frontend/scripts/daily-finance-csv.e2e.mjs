import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { api, startTestServer } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';

// 실제 회사 권한/HTTP/네이티브 PG와 배포 빌드에서 CSV 파일 자체를 검증한다.
const evidence = fileURLToPath(new URL('../.artifacts/daily-finance-csv/', import.meta.url));
await mkdir(evidence, { recursive: true });
let fixture, server, vite, browser;
const errors = [], observations = [];
function parseCsv(text) {
  const rows = [], row = []; let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(cell); cell = ''; if (c === '\n') { rows.push([...row]); row.length = 0; } }
    else cell += c;
  }
  assert.equal(quoted, false); row.push(cell); rows.push(row); return rows;
}
try {
  fixture = await startDailyNativePostgres(); server = await startTestServer();
  const { pool, companyId, otherCompanyId, assigneeId } = fixture;
  const codes = ['dues.read','dues.write','approval.request','approval.decide','menu.finance','menu.approvals'];
  await pool.query("INSERT INTO org.permissions(code,module) SELECT code,'qa' FROM unnest($1::text[]) code ON CONFLICT DO NOTHING", [codes]);
  await pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.name='DAILY_TEST_ROLE' AND p.code=ANY($1::text[]) ON CONFLICT DO NOTHING", [codes]);
  await pool.query("INSERT INTO org.company_modules(company_id,module_key) SELECT $1,k FROM unnest(ARRAY['finance','approvals']) k ON CONFLICT DO NOTHING", [companyId]);
  await pool.query("INSERT INTO org.company_feature_settings(company_id,enabled_features) VALUES($1,ARRAY['approvals'])", [companyId]);
  const special = '=SUM(1,2) "QA"\nRecipient';
  await pool.query('UPDATE auth.users SET name=$1 WHERE id=$2', [special, assigneeId]);
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  const session = { token: login.body.token, orgId: `pg:${companyId}` };
  async function request(route, body, status = 201) {
    const result = await api(server.baseUrl, '/pg' + route, { ...session, method: body ? 'POST' : 'GET', body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    assert.equal(result.status, status); return result.body;
  }
  const dues = [], approvals = [];
  for (let i = 0; i < 25; i++) {
    dues.push((await request('/finance/dues', { target_user_id: i % 2 ? fixture.identity.users[0].id : assigneeId, amount: i === 24 ? '9999999999999999.99' : '1.01' })).id);
    approvals.push((await request('/approvals', { request_type: i === 0 ? special : `CSV approval ${i}`, note: 'note, "quoted"\nnext line' })).id);
  }
  await request(`/finance/dues/${dues[0]}/payments`, { amount: '1.01', expected_version: 1 });
  await request(`/approvals/${approvals[0]}/decide`, { decision: 'reject', comment: '@SUM(1,2)\r\n"decision"' }, 200);
  await pool.query("INSERT INTO accounting.dues_charges(company_id,target_user_id,amount) VALUES($1,$2,42.00)", [otherCompanyId, fixture.foreignId]);
  await pool.query("INSERT INTO org.approval_requests(company_id,requester_id,request_type) VALUES($1,$2,'FOREIGN_PRIVATE')", [otherCompanyId, fixture.foreignId]);
  vite = await preview({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), preview: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } } });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  console.log(JSON.stringify({ chrome: browser.version(), api: server.baseUrl, origin }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route(url => url.hostname !== '127.0.0.1', route => route.abort());
  await context.addInitScript(s => localStorage.setItem('orbitflow.session.v1', JSON.stringify(s)), { ...session, name: 'CSV QA', email: 'qa@example.invalid', mustChangePassword: false, organizations: [{ org_id: session.orgId, org_name: 'CSV QA', org_type: 'perp_db', roles: [] }] });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  async function download(kind, stage, expected) {
    const button = page.getByRole('button', { name: /내보내기/ });
    assert.equal(await button.count(), 1, `${kind}: filtered CSV action must exist`);
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), button.click()]);
    const raw = await readFile(await file.path(), 'utf8');
    assert.ok(raw.startsWith('\uFEFF')); const rows = parseCsv(raw.slice(1));
    assert.equal(rows.length - 1, expected); assert.ok(rows.every(row => row.length === rows[0].length));
    assert.equal(raw.includes('FOREIGN_PRIVATE'), false);
    await writeFile(evidence + `${kind}-${stage}.csv`, raw);
    observations.push({ kind, stage, rows: expected, headers: rows[0], filename: file.suggestedFilename() });
    return rows;
  }
  for (const [kind, route, ids, status] of [['dues','/finance/dues',dues,'paid'],['approval','/approvals',approvals,'rejected']]) {
    const signal = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/pg' + route && r.request().method() === 'GET');
    await page.goto(origin + route); const payload = await (await signal).json(); assert.equal(payload.items.length, 25);
    const rows = page.locator(`[data-${kind}-id]`); await expect(rows).toHaveCount(25);
    // 마지막 행에 도달한 상태에서도 전체 필터 결과를 내보낸다.
    await rows.last().scrollIntoViewIfNeeded();
    const all = await download(kind, 'all', 25);
    assert.deepEqual(all.slice(1).map(row => row[0]).sort(), [...ids].sort());
    assert.deepEqual(all[0], kind === 'dues' ? ['ID','대상','청구액','납부액','잔액','기한','상태'] : ['ID','유형','신청자','대상','상태','신청일','신청 내용','처리 의견','처리일']);
    if (kind === 'dues') {
      const large = all.find(row => row[0] === dues[24]); assert.equal(large[2], '9999999999999999.99'); assert.equal(large[4], '9999999999999999.99');
    }
    await page.locator('.daily-finance__filters select').selectOption(status); await expect(rows).toHaveCount(1);
    const filtered = await download(kind, 'status', 1); assert.equal(filtered[1][0], ids[0]); assert.equal(filtered[1][1], "'" + special);
    if (kind === 'dues') assert.deepEqual(filtered[1].slice(2, 5), ['1.01','1.01','0.00']);
    else {
      assert.equal(JSON.parse(filtered[1][6]).note, 'note, "quoted"\nnext line');
      assert.equal(filtered[1][7], "'@SUM(1,2)\r\n\"decision\"");
      assert.equal(filtered[1][5], payload.items.find(row => String(row.__id) === ids[0]).신청일);
    }
    await page.locator('.daily-finance__filters input').fill('no matching record'); await expect(rows).toHaveCount(0);
    const empty = await download(kind, 'empty', 0); assert.deepEqual(empty[0], all[0]);
    await page.locator('.daily-finance__filters input').fill(''); await expect(rows).toHaveCount(1); await download(kind, 'restored', 1);
    await page.screenshot({ path: evidence + `${kind}-filtered.png`, fullPage: true, animations: 'disabled' });
    await page.locator('.daily-finance__filters select').selectOption('');
    await page.locator('.daily-finance__filters input').fill(kind === 'dues' ? 'Recipient' : 'CSV approval');
    await expect(rows).toHaveCount(kind === 'dues' ? 13 : 24); await download(kind, 'search', kind === 'dues' ? 13 : 24);
  }
  assert.deepEqual(errors, []); await writeFile(evidence + 'result.json', JSON.stringify(observations, null, 2));
  await context.unrouteAll({ behavior: 'wait' }); await context.close();
  console.log('DAILY_FINANCE_CSV_PASS all25/status1/intersection0/restored1/search; exact decimals/IDs/headers/quoted multiline/formula safety/foreign exclusion');
} finally {
  await browser?.close();
  if (vite) await new Promise((resolve, reject) => vite.httpServer.close(e => e ? reject(e) : resolve()));
  if (server) { await (await import('../../backend/src/config/pg.js')).closePgPool(); await server.close(); }
  await fixture?.close(); console.log('DAILY_FINANCE_CSV_OWNED_SERVICES_AND_DATA_CLEANED');
}
