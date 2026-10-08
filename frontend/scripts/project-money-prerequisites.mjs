import assert from 'node:assert/strict';
import { dom } from './deadline-expense-actions.mjs';

export async function projectMoneyPrerequisites({ page, native, sqlite, actor, pg, account, incomeAccount, routePath }) {
  const setActive = async (id, active) => pg
    ? native.pool.query('UPDATE accounting.accounts SET is_active=$1 WHERE id=$2 AND company_id=$3', [active, id, actor.orgId.slice(3)])
    : sqlite.db().prepare('UPDATE account SET active=? WHERE id=? AND org_id=?').run(active ? 1 : 0, id, actor.orgId);
  async function refresh(expenseReady, incomeReady) {
    const summary = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(routePath) && response.request().method() === 'GET');
    const state = dom(page, `[data-project-money][data-setup-loaded="true"][data-expense-ready="${expenseReady}"][data-income-ready="${incomeReady}"]`);
    await page.getByRole('button', { name: '재무 새로고침', exact: true }).click(); assert.equal((await summary).status(), 200); await state;
    assert.equal(await page.getByRole('button', { name: '프로젝트 지출 기록', exact: true }).isDisabled(), !expenseReady);
    assert.equal(await page.getByRole('button', { name: '프로젝트 수입 기록', exact: true }).isDisabled(), !incomeReady);
  }
  let cash;
  try {
    await setActive(incomeAccount, false); await refresh(true, false);
    const expenseForm = dom(page, `[data-expense-form] option[value="${account}"]`);
    await page.getByRole('button', { name: '프로젝트 지출 기록', exact: true }).click(); await expenseForm;
    await page.locator('[data-expense-form]').getByRole('button', { name: '입력 닫기', exact: true }).click();
    await setActive(incomeAccount, true); await setActive(account, false); await refresh(false, true);
    const incomeForm = dom(page, `[data-income-form] option[value="${incomeAccount}"]`);
    await page.getByRole('button', { name: '프로젝트 수입 기록', exact: true }).click(); await incomeForm;
    await page.locator('[data-income-form]').getByRole('button', { name: '입력 닫기', exact: true }).click();
    await setActive(account, true);
    if (pg) {
      cash = (await native.pool.query("SELECT id FROM accounting.accounts WHERE company_id=$1 AND account_type='asset' AND is_active ORDER BY id LIMIT 1", [actor.orgId.slice(3)])).rows[0].id;
      await setActive(cash, false); await refresh(false, false); await setActive(cash, true);
    }
    await refresh(true, true);
  } finally { await setActive(account, true); await setActive(incomeAccount, true); if (cash) await setActive(cash, true); }
}
