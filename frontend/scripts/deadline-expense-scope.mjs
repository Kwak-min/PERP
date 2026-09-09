import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import sharp from 'sharp';
import { dom } from './deadline-expense-actions.mjs';

export async function expenseScope({ page, fixture, origin, result }) {
  const { actor, foreign, prefix, pg, request, expense } = fixture;
  const apiPrefix = '/api/v1' + prefix + '/finance';
  const events = new EventEmitter();
  const signal = event => once(events, event, { signal: AbortSignal.timeout(15000) });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
  // 실제 브라우저의 storage 이벤트 소비 경계로 회사/로그인 변경을 전달한다.
  async function switchActor(who) {
    await page.evaluate(who => {
      const key = 'orbitflow.session.v1', oldValue = localStorage.getItem(key), previous = JSON.parse(oldValue);
      const next = { ...previous, token: who.token, orgId: who.orgId, organizations: [{ org_id: who.orgId, org_name: '격리 재무', org_type: 'custom', roles: ['owner'] }] };
      const newValue = JSON.stringify(next); localStorage.setItem(key, newValue); window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue }));
    }, who);
  }
  await page.goto(origin + '/finance/transactions', { waitUntil: 'domcontentloaded' }); await dom(page, '[data-expense-entry]');
  await page.locator('[data-expense-entry]').click(); await dom(page, '[data-expense-form] option[value="' + expense + '"]');
  const form = page.locator('[data-expense-form]');
  await form.locator('[name="merchant"]').fill('PRESERVED_RETRY_DRAFT');
  // 업로드 실패는 HTTP 경계에만 주입한다. 재시도는 동일 파일로 실제 검증·저장을 통과해야 한다.
  let fail = true;
  await page.route('**' + apiPrefix + '/transactions/receipt-uploads', async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture upload unavailable', details: {}, request_id: '' } }) }); }
    else await route.continue();
  });
  await form.locator('[name="receipts"]').setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: png }); await dom(page, '[data-upload-state="failed"]');
  assert.equal(await form.locator('[name="merchant"]').inputValue(), 'PRESERVED_RETRY_DRAFT');
  const retry = page.waitForResponse(r => new URL(r.url()).pathname === apiPrefix + '/transactions/receipt-uploads');
  await form.getByRole('button', { name: '업로드 재시도', exact: true }).click(); assert.equal((await retry).status(), 201); await dom(page, '[data-upload-state="ready"]');
  await page.unroute('**' + apiPrefix + '/transactions/receipt-uploads'); await form.getByRole('button', { name: '제거', exact: true }).click();
  // 미첨부 사유 저장과 선택 시각 생략을 실제 strict POST로 확인한다.
  await form.locator('[name="amount"]').fill(pg ? '10000000000000000' : '90071992547409.92');
  await form.locator('[name="expense_date"]').fill('2026-09-08'); await form.locator('[name="account_id"]').selectOption(expense);
  await form.locator('[name="no_receipt_reason"]').fill('원본 분실'); await form.locator('input[type="checkbox"]').check();
  await form.locator('button[type="submit"]').click(); await dom(page, '[data-expense-form] [role="alert"]');
  assert.equal(await form.locator('[name="merchant"]').inputValue(), 'PRESERVED_RETRY_DRAFT');
  assert.equal(await page.locator('[data-expense-success]').count(), 0);
  await form.locator('[name="amount"]').fill('100.01'); await form.locator('input[type="checkbox"]').check();
  const save = page.waitForResponse(r => new URL(r.url()).pathname === apiPrefix + '/expenses');
  await form.locator('button[type="submit"]').click(); const saved = await save; assert.equal(saved.status(), 201); const body = await saved.json();
  assert.equal(body.no_receipt_reason, '원본 분실'); assert.equal(body.occurred_at, null);
  await dom(page, '[data-detail-amount]');
  const denied = await fetch(origin + apiPrefix + `/transactions/${body.id}`, { headers: { Authorization: `Bearer ${foreign.token}`, 'X-Org-Id': foreign.orgId }, signal: AbortSignal.timeout(10000) });
  assert.equal(denied.status, 404);
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await page.locator('[data-expense-entry]').click(); await dom(page, '[data-expense-form] option[value="' + expense + '"]');
  // 성공 업로드 결과를 붙잡은 동안 회사를 바꾸면 오래된 결과가 새 초안으로 들어오지 않는다.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**' + apiPrefix + '/transactions/receipt-uploads', async route => {
    const uploaded = await route.fetch(); events.emit('uploaded'); await gate;
    await route.fulfill({ response: uploaded }); events.emit('released');
  });
  const uploaded = signal('uploaded');
  await page.locator('[data-expense-form] [name="receipts"]').setInputFiles({ name: 'old-company.png', mimeType: 'image/png', buffer: png }); await uploaded;
  const newList = dom(page, '[data-ledger-count="0"]'); await switchActor(foreign); await newList;
  const released = signal('released'); release(); await released;
  assert.equal(await page.locator('[data-upload-state], [data-expense-success]').count(), 0);
  await page.unroute('**' + apiPrefix + '/transactions/receipt-uploads');
  // 같은 orgId의 토큰 변경도 별도 scope다. 서버가 커밋한 옛 actor 응답은 새 actor 상태를 복원하지 않는다.
  const reset = dom(page, '[data-ledger-count="105"]'); await switchActor(actor); await reset;
  await page.locator('[data-expense-entry]').click(); await dom(page, '[data-expense-form] option[value="' + expense + '"]');
  const f = page.locator('[data-expense-form]');
  await f.locator('[name="merchant"]').fill('OLD_USER_RESPONSE'); await f.locator('[name="amount"]').fill('10.01');
  await f.locator('[name="expense_date"]').fill('2026-09-08'); await f.locator('[name="account_id"]').selectOption(expense); await f.locator('[name="no_receipt_reason"]').fill('분실'); await f.locator('input[type="checkbox"]').check();
  let releaseSave; const saveGate = new Promise(resolve => { releaseSave = resolve; });
  await page.route('**' + apiPrefix + '/expenses', async route => { const response = await route.fetch(); events.emit('committed'); await saveGate; await route.fulfill({ response }); events.emit('save-released'); });
  const committed = signal('committed'); await f.locator('button[type="submit"]').click(); await committed;
  await switchActor({ token: foreign.token, orgId: actor.orgId });
  const flushed = signal('save-released'); releaseSave(); await flushed;
  assert.equal(await page.locator('[data-expense-success]').count(), 0);
  assert.equal(await page.locator('[data-expense-form] [name="merchant"]').count(), 0);
  await page.unroute('**' + apiPrefix + '/expenses');
  result.cases.push({ source: pg ? 'pg' : 'legacy', uploadRetry: true, reasonSaved: body.id, optionalTime: body.occurred_at, foreignDetail: denied.status, companyChangeIgnoresUpload: true, userChangeIgnoresCommittedResult: true });
}
