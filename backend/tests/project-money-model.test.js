import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TABLES } from '../src/config/schema.js';
import { migrateProjectMoney } from '../src/config/project-money-migration.js';
import { projectMoneySummary } from '../src/services/project-money.service.js';

test('additive SQLite project migration preserves historical unlinked and inconsistent source rows', () => {
  const conn = new DatabaseSync(':memory:');
  try {
    for (const sql of TABLES) conn.exec(sql);
    conn.exec(`INSERT INTO project(id,tenant_id,org_id,name,budget_amount,created_at,updated_at) VALUES('p','t','o','legacy',900000,'2020','2020');
      INSERT INTO budget(id,tenant_id,org_id,name,amount_minor,created_at,updated_at) VALUES('b','t','o','legacy budget',10001,'2020','2020');
      INSERT INTO transaction_record(id,tenant_id,org_id,amount_minor,budget_id,occurred_on,status,created_at,updated_at) VALUES('e','t','o',101,'b','2020-01-01','confirmed','2020','2020');
      INSERT INTO transaction_record(id,tenant_id,org_id,amount_minor,budget_id,occurred_on,status,created_at,updated_at) VALUES('old-inconsistent','t','other',202,'b','2020-01-01','confirmed','2020','2020');`);
    const before = ['project', 'budget', 'transaction_record'].map(table => conn.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    migrateProjectMoney(conn);
    const after = ['project', 'budget', 'transaction_record'].map(table => conn.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => { const { money_currency, ...original } = row; if (table === 'budget') assert.equal(money_currency, null); return original; }));
    assert.deepEqual(after, before.map(rows => rows.map(row => ({ ...row }))));
    assert.throws(() => conn.exec("INSERT INTO transaction_record(id,tenant_id,org_id,amount_minor,budget_id,occurred_on,created_at,updated_at) VALUES('new-invalid','t','other',202,'b','2026-09-09','now','now')"), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
  } finally { conn.close(); }
});

test('project money decimal contract: negative cents, no currency mixing and absent income', () => {
  const budgets = [{ id: 'b', name: '예산', amount: '0.01', unit: 'KRW', version: 1, account_id: null }];
  const entries = [{ id: 'e', budget_id: 'b', unit: 'KRW', expense: '0.02', income: '0.01', has_income: true }];
  const result = projectMoneySummary('p', budgets, entries);
  assert.deepEqual(result.totals, [{ unit: 'KRW', allocated: '0.01', spending: '0.02', remaining: '-0.01', income: '0.01', net: '-0.01' }]);
  assert.equal(result.budgets[0].remaining, '-0.01');
  const mixed = projectMoneySummary('p', budgets, [...entries, { id: 'usd', budget_id: 'b', unit: 'USD', expense: '99.99', income: '0', has_income: false }]);
  assert.equal(mixed.totals.find(row => row.unit === 'KRW').spending, '0.02');
  assert.equal(mixed.totals.find(row => row.unit === 'USD').spending, '99.99');
  assert.equal(mixed.totals.find(row => row.unit === 'USD').income, null);
  assert.equal(mixed.budgets[0].remaining, null); assert.equal(mixed.budgets[0].spending, null);
  assert.equal(mixed.entries.find(row => row.id === 'usd').income, '0.00');
  assert.deepEqual(projectMoneySummary('p', [], []).totals, []);
});
