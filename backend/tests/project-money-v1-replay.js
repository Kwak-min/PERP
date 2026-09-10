import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// v1의 machine-consumed 정규화 본문을 고정한다. 신규 optional field는 생략된 원본 해시에 추가하지 않는다.
export async function projectMoneyV1Replay({ request, replayRow, snapshot, projectId, incomeId, expenseId }) {
  const cases = [
    { route: '/finance/incomes', operation: 'income.create', body: { amount: '11.01', income_date: '2026-09-09', payer: 'V1 payer', account_id: incomeId, memo: 'V1' },
      canonical: { kind: 'income', amount: '11.01', input_currency: 'KRW', entry_date: '2026-09-09', counterparty: 'V1 payer', account_id: incomeId, memo: 'V1' } },
    { route: '/finance/expenses', operation: 'expense.create', body: { amount: '3.02', expense_date: '2026-09-09', merchant: 'V1 vendor', account_id: expenseId, no_receipt_reason: 'V1 reason', memo: 'V1' },
      canonical: { kind: 'expense', amount: '3.02', entry_date: '2026-09-09', counterparty: 'V1 vendor', occurred_at: null, input_currency: 'KRW', no_receipt_reason: 'V1 reason', account_id: expenseId, budget_id: null, memo: 'V1', receipt_tokens: [] } },
  ];
  for (const item of cases) {
    const key = randomUUID(), original = await request(item.route, item.body, 201, key);
    const stored = await replayRow(item.operation, key);
    const payload = typeof stored.payload === 'string' ? JSON.parse(stored.payload) : stored.payload;
    assert.deepEqual(payload, item.canonical); assert.equal(Object.hasOwn(payload, 'project_id'), false);
    if (typeof stored.payload === 'string') assert.equal(stored.payload, JSON.stringify(item.canonical));
    const before = await snapshot();
    assert.deepEqual(await request(item.route, item.body, 201, key), original);
    assert.deepEqual(await request(item.route, { ...item.body, project_id: null }, 201, key), original);
    await request(item.route, { ...item.body, project_id: projectId }, 409, key);
    assert.deepEqual(await snapshot(), before);
    assert.equal(original.project_id, null);
  }
}
