import assert from 'node:assert/strict';
import { dom } from './deadline-expense-actions.mjs';

export async function recoverProjectMoney({ page, origin, kind, projectId, otherProjectId, amount, accountId, budgetId = null }) {
  const stored = () => page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).filter(key => key.startsWith('orbitflow.money-attempt.v1:')).map(key => [key, sessionStorage.getItem(key)])));
  const before = await stored(); assert.equal(Object.keys(before).length, 1);
  const envelope = JSON.parse(Object.values(before)[0]); assert.equal(envelope.body.project_id, projectId);
  if (kind === 'expense') assert.equal(envelope.body.budget_id, budgetId);
  async function restored() {
    await dom(page, `[data-${kind}-form][data-money-state="uncertain"]`);
    await dom(page, `[data-${kind}-form] option[value="${accountId}"]`);
    const form = page.locator(`[data-${kind}-form]`);
    assert.equal(await form.locator('[name=amount]').inputValue(), amount);
    assert.equal(await form.locator('[name=amount]').isDisabled(), true);
    assert.equal(await form.locator('[data-money-project]').getAttribute('data-money-project'), projectId);
    if (kind === 'expense') assert.equal(await form.locator('[name=budget_id]').inputValue(), budgetId);
  }
  await page.reload({ waitUntil: 'domcontentloaded' }); await restored();
  await page.goto(`${origin}/projects/${otherProjectId}`, { waitUntil: 'domcontentloaded' }); await dom(page, '[data-project-money-pending]');
  assert.equal(await page.locator('[data-income-form], [data-expense-form]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '프로젝트 지출 기록', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '프로젝트 수입 기록', exact: true }).isDisabled(), true);
  await page.goto(origin + '/finance', { waitUntil: 'domcontentloaded' }); await restored();
  await page.goto(`${origin}/projects/${projectId}`, { waitUntil: 'domcontentloaded' }); await restored();
  assert.deepEqual(await stored(), before);
}
