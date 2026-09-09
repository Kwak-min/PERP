import assert from 'node:assert/strict';
import { dom } from './deadline-expense-actions.mjs';

export async function recoverMoneyEntry({ page, origin, kind, amount, accountId }) {
  const form = page.locator(`[data-${kind}-form]`);
  async function restored() {
    await dom(page, `[data-${kind}-form][data-money-state="uncertain"], [data-${kind}-entry]:not(:disabled)`);
    if (!await form.count()) await page.locator(`[data-${kind}-entry]`).click();
    await dom(page, `[data-${kind}-form] option[value="${accountId}"]`);
    assert.equal(await form.locator('[name="amount"]').inputValue(), amount, `${kind} pending payload survives reload/navigation`);
    assert.equal(await form.getAttribute('data-money-state'), 'uncertain');
    assert.equal(await form.locator('[name="amount"]').isDisabled(), true);
  }
  await page.reload({ waitUntil: 'domcontentloaded' }); await restored();
  await page.goto(origin + '/finance/transactions', { waitUntil: 'domcontentloaded' }); await restored();
  await page.goto(origin + '/finance', { waitUntil: 'domcontentloaded' }); await restored();
}

export async function switchMoneySession(page, origin, session) {
  await page.evaluate(value => { sessionStorage.removeItem('orbitflow.session.v1'); localStorage.setItem('orbitflow.session.v1', JSON.stringify(value)); }, session);
  await page.goto(origin + '/finance', { waitUntil: 'domcontentloaded' });
}
export async function assertMoneyScopeIsolation({ page, origin, kind, originalSession, otherAccountSession, otherSpaceSession, amount, accountId }) {
  for (const other of [otherAccountSession, otherSpaceSession]) {
    await switchMoneySession(page, origin, other);
    await dom(page, `[data-${kind}-entry]:not(:disabled)`);
    assert.equal(await page.locator('[data-money-state="uncertain"]').count(), 0);
    const opened = dom(page, `[data-${kind}-form]`); await page.locator(`[data-${kind}-entry]`).click(); await opened;
    assert.equal(await page.locator(`[data-${kind}-form] [name="amount"]`).inputValue(), '');
    assert.equal(await page.locator(`[data-${kind}-form] [name="memo"]`).inputValue(), '');
  }
  await switchMoneySession(page, origin, originalSession);
  await recoverMoneyEntry({ page, origin, kind, amount, accountId });
}
export const moneyPendingKeys = page => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('orbitflow.money-attempt.v1:')));

export async function assertMoneyLogout({ page, origin, session, incomeId, apiPrefix, request, pg }) {
  await switchMoneySession(page, origin, session); await dom(page, '[data-income-entry]:not(:disabled)');
  const opened = dom(page, `[data-income-form] option[value="${incomeId}"]`); await page.locator('[data-income-entry]').click(); await opened;
  const form = page.locator('[data-income-form]');
  await form.locator('[name="amount"]').fill('5.03'); await form.locator('[name="income_date"]').fill('2026-09-09');
  await form.locator('[name="payer"]').fill('로그아웃 검증'); await form.locator('[name="account_id"]').selectOption(incomeId); await form.locator('[name="memo"]').fill('LOGOUT_PENDING'); await form.locator('input[type="checkbox"]').check();
  await page.route('**' + apiPrefix + '/incomes', async route => { const response = await route.fetch(); assert.equal(response.status(), 201); await route.fulfill({ status: 201, contentType: 'application/json', body: '{' }); });
  const uncertain = dom(page, '[data-income-form][data-money-state="uncertain"]'); await form.locator('button[type="submit"]').click(); await uncertain;
  assert.equal((await moneyPendingKeys(page)).length, 1);
  const logout = page.getByRole('button', { name: '로그아웃', exact: true });
  if (!await logout.isVisible()) await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  const loggedOut = page.waitForURL('**/login', { timeout: 10000 }); await logout.click(); await loggedOut;
  assert.deepEqual(await moneyPendingKeys(page), []);
  await page.unroute('**' + apiPrefix + '/incomes');
  const login = await request(null, '/auth/login', { email: session.email, password: 'password-1234' });
  await switchMoneySession(page, origin, { ...session, token: pg ? login.token : login.access_token });
  await dom(page, '[data-income-entry]:not(:disabled)'); assert.equal(await page.locator('[data-income-form]').count(), 0);
  const blank = dom(page, '[data-income-form]'); await page.locator('[data-income-entry]').click(); await blank;
  assert.equal(await page.locator('[data-income-form] [name="memo"]').inputValue(), '');
  assert.deepEqual(await moneyPendingKeys(page), []);
}
