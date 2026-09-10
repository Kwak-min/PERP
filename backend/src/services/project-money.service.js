import { z } from 'zod';
import { db } from '../config/db.js';
import { pgTransaction } from '../config/pg.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { getScoped, insert, bumpVersion } from '../models/base.js';
import { ApiError, notFound } from '../utils/errors.js';
import { freshReceiptPrincipal, legacyReceiptParent } from './legacy-receipt-files.service.js';
import { freshPgReceiptPrincipal } from './pg-receipt-files.service.js';
import { requireProjectMoneyScope, requirePgProjectMoneyAccess } from './project-money-links.service.js';
import { money, cents, replayPgMutation, recordEvent } from './pg-finance.service.js';
import { legacyMinor } from './expense-input.service.js';
import { replayLegacyMutation } from './legacy-expenses.service.js';
import * as audit from './audit.service.js';

export const projectBudgetInput = z.object({ name: z.string().trim().min(1).max(200), amount: z.string().transform(money), currency: z.literal('KRW'), account_id: z.string().min(1).nullable().optional() }).strict();
export const associationInput = z.object({ expected_version: z.number().int().positive().safe() }).strict();
const exact = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const minor = value => { const text = String(value); return text.startsWith('-') ? -cents(text.slice(1)) : cents(text); };

// 전표의 확정 귀속만 사용한다. 예산 연결을 과거 전표의 귀속으로 추론하지 않는다.
export function projectMoneySummary(projectId, budgets, entries, scope = 'all') {
  const groups = new Map();
  const group = unit => { if (!groups.has(unit)) groups.set(unit, { allocated: 0n, spending: 0n, income: 0n, hasIncome: false }); return groups.get(unit); };
  for (const budget of budgets) group(budget.unit).allocated += minor(budget.amount);
  for (const entry of entries) {
    const total = group(entry.unit);
    total.spending += minor(entry.expense); total.income += minor(entry.income);
    total.hasIncome ||= entry.has_income;
  }
  return { project_id: String(projectId), generated_at: new Date().toISOString(), scope, basis: 'explicit_posted_project',
    totals: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([unit, value]) => ({ unit, allocated: exact(value.allocated), spending: exact(value.spending),
      remaining: unit === 'currency_unspecified' || unit === 'ledger_decimal' ? null : exact(value.allocated - value.spending),
      income: value.hasIncome ? exact(value.income) : null, net: value.hasIncome ? exact(value.income - value.spending) : null })),
    budgets: budgets.map(budget => {
      const linked = entries.filter(entry => entry.budget_id === budget.id);
      const comparable = budget.unit !== 'currency_unspecified' && budget.unit !== 'ledger_decimal' && linked.every(entry => entry.unit === budget.unit);
      const spent = comparable ? linked.reduce((sum, entry) => sum + minor(entry.expense), 0n) : 0n;
      return { ...budget, spending: comparable ? exact(spent) : null, remaining: comparable ? exact(minor(budget.amount) - spent) : null };
    }),
    entries: entries.map(({ has_income, ...entry }) => ({ ...entry, expense: exact(minor(entry.expense)), income: exact(minor(entry.income)) })) };
}

function legacyContext(req, write = false) {
  const principal = freshReceiptPrincipal(resolvePrincipal(req), 'transaction');
  principal.require('budget.read'); principal.require('transaction.read');
  const project = getScoped('project', principal, req.params.projectId);
  requireProjectMoneyScope(principal, project);
  if (write) { principal.require('project.write'); principal.require('budget.write'); }
  return { principal, project };
}
export function legacyProjectMoney(req) {
  db().exec('BEGIN');
  try {
    const { principal: p, project } = legacyContext(req);
    if (p.scope !== 'all') {
      // 현재 금융 상세의 행 범위를 집계로 우회하지 않는다. 일부 행으로 전체 잔여를 만들지 않는다.
      const ids = db().prepare("SELECT id FROM transaction_record WHERE tenant_id=? AND org_id=? AND project_id=? AND status='confirmed' AND deleted_at IS NULL").all(p.tenantId, p.orgId, project.id);
      for (const entry of ids) legacyReceiptParent(p, { kind: 'transaction', parentId: entry.id });
      if (db().prepare('SELECT 1 FROM budget WHERE tenant_id=? AND org_id=? AND project_id=? AND deleted_at IS NULL AND (created_by IS NULL OR created_by<>?) LIMIT 1').get(p.tenantId, p.orgId, project.id, p.userId)) throw notFound('budget');
    }
    const budgets = db().prepare(`SELECT id,name,CAST(amount_minor AS TEXT) AS minor,money_currency AS unit,status,version,account_id
      FROM budget WHERE tenant_id=? AND org_id=? AND project_id=? AND deleted_at IS NULL ORDER BY created_at,id`).all(p.tenantId, p.orgId, project.id)
      .map(({ minor: amount, ...row }) => ({ ...row, amount: exact(BigInt(amount)), unit: row.unit ?? 'currency_unspecified' }));
    const entries = db().prepare(`SELECT id,budget_id,kind,CAST(amount_minor AS TEXT) AS minor,currency AS unit,occurred_on AS date,memo FROM transaction_record
      WHERE tenant_id=? AND org_id=? AND project_id=? AND status='confirmed' AND deleted_at IS NULL ORDER BY occurred_on DESC,id`).all(p.tenantId, p.orgId, project.id)
      .map(({ minor: amount, kind, ...row }) => ({ ...row, expense: kind === 'expense' ? exact(BigInt(amount)) : '0.00', income: kind === 'income' ? exact(BigInt(amount)) : '0.00', has_income: kind === 'income' }));
    const available = db().prepare(`SELECT id,name,version FROM budget WHERE tenant_id=? AND org_id=? AND project_id IS NULL AND deleted_at IS NULL
      AND (?='all' OR created_by=?) ORDER BY name,id`).all(p.tenantId, p.orgId, p.scope, p.userId);
    const result = { ...projectMoneySummary(project.id, budgets, entries, p.scope), available_budgets: available };
    db().exec('COMMIT'); return result;
  } catch (error) { db().exec('ROLLBACK'); throw error; }
}
export function legacyProjectBudget(req, associate = false) {
  const body = (associate ? associationInput : projectBudgetInput).parse(req.body);
  db().exec('BEGIN IMMEDIATE');
  try {
    const { principal: p, project } = legacyContext(req, true);
    let before;
    if (associate) {
      before = getScoped('budget', p, req.params.budgetId);
      if (p.scope !== 'all' && before.created_by !== p.userId) throw notFound('budget');
      if (before.project_id && before.project_id !== project.id) throw new ApiError('CONFLICT', '이미 다른 프로젝트에 연결된 예산은 옮길 수 없습니다.');
    } else if (body.account_id) {
      const account = getScoped('account', p, body.account_id);
      if (!account.active || account.kind !== 'expense') throw new ApiError('VALIDATION_ERROR', '활성 지출 계정을 선택하세요.');
    }
    const payload = { project_id: project.id, ...(associate ? { budget_id: before.id } : {}), ...body };
    const result = replayLegacyMutation(req, p, { operation: associate ? 'project.budget.associate' : 'project.budget.create', payload }, () => {
      if (associate && before.version !== body.expected_version) throw new ApiError('VERSION_CONFLICT', '예산이 변경되었습니다. 새로고침하세요.');
      const budget = associate ? bumpVersion('budget', before, { project_id: project.id }, p.userId) : insert('budget', {
        tenant_id: p.tenantId, org_id: p.orgId, project_id: project.id, name: body.name, amount_minor: legacyMinor(body.amount), money_currency: body.currency,
        account_id: body.account_id ?? null, created_by: p.userId,
      });
      const response = { id: budget.id, project_id: project.id, version: budget.version };
      audit.record({ tenantId: p.tenantId, orgId: p.orgId, actorId: p.userId, action: associate ? 'project.budget.associated' : 'project.budget.created', resourceType: 'budget', resourceId: budget.id, before: before ?? null, after: budget, requestId: req.requestId });
      return response;
    });
    db().exec('COMMIT'); return result;
  } catch (error) { db().exec('ROLLBACK'); throw error; }
}

async function pgContext(client, req, write = false) {
  const p = await freshPgReceiptPrincipal(client, pgIdentity(req), 'transaction', true);
  await requirePgProjectMoneyAccess(client, p); p.require('budget.read');
  if (!/^[1-9]\d*$/.test(req.params.id)) throw notFound('project');
  const project = (await client.query('SELECT id FROM project.projects WHERE company_id=$1 AND id=$2 FOR SHARE', [p.companyId, req.params.id])).rows[0];
  if (!project) throw notFound('project');
  if (write) { p.require('project.write'); p.require('budget.write'); }
  return { principal: p, project };
}
export function pgProjectMoney(req) {
  return pgTransaction(async client => {
    const { principal: p, project } = await pgContext(client, req);
    const budgets = (await client.query(`SELECT id::text,name,amount::text,COALESCE(money_currency,'ledger_decimal') AS unit,status,version,account_id::text
      FROM accounting.budgets WHERE company_id=$1 AND project_id=$2 ORDER BY created_at,id`, [p.companyId, project.id])).rows;
    const entries = (await client.query(`SELECT e.id::text,e.budget_id::text,COALESCE(e.input_currency,'ledger_decimal') AS unit,to_char(e.entry_date,'YYYY-MM-DD') AS date,e.memo,
      COALESCE(SUM(l.debit-l.credit) FILTER(WHERE a.account_type='expense'),0)::text AS expense,
      COALESCE(SUM(l.credit-l.debit) FILTER(WHERE a.account_type='revenue'),0)::text AS income,
      COALESCE(BOOL_OR(a.account_type='revenue'),false) AS has_income
      FROM accounting.journal_entries e LEFT JOIN accounting.journal_lines l ON l.entry_id=e.id
      LEFT JOIN accounting.accounts a ON a.id=l.account_id AND a.company_id=e.company_id
      WHERE e.company_id=$1 AND e.project_id=$2 AND e.posted GROUP BY e.id ORDER BY e.entry_date DESC,e.id`, [p.companyId, project.id])).rows;
    const available = (await client.query('SELECT id::text,name,version FROM accounting.budgets WHERE company_id=$1 AND project_id IS NULL ORDER BY name,id', [p.companyId])).rows;
    return { ...projectMoneySummary(project.id, budgets, entries), available_budgets: available };
  });
}
export function pgProjectBudget(req, associate = false) {
  const body = (associate ? associationInput : projectBudgetInput).parse(req.body);
  return pgTransaction(async client => {
    const { principal: p, project } = await pgContext(client, req, true);
    let before;
    if (associate) {
      if (!/^[1-9]\d*$/.test(req.params.budgetId)) throw notFound('budget');
      before = (await client.query('SELECT * FROM accounting.budgets WHERE company_id=$1 AND id=$2 FOR UPDATE', [p.companyId, req.params.budgetId])).rows[0];
      if (!before) throw notFound('budget');
      if (before.project_id && String(before.project_id) !== String(project.id)) throw new ApiError('CONFLICT', '이미 다른 프로젝트에 연결된 예산은 옮길 수 없습니다.');
    } else if (body.account_id) {
      if (!/^[1-9]\d*$/.test(body.account_id)) throw new ApiError('VALIDATION_ERROR', '활성 지출 계정을 선택하세요.');
      const account = (await client.query("SELECT id FROM accounting.accounts WHERE company_id=$1 AND id=$2 AND is_active AND account_type='expense' FOR SHARE", [p.companyId, body.account_id])).rows[0];
      if (!account) throw new ApiError('VALIDATION_ERROR', '현재 회사의 활성 지출 계정을 선택하세요.');
    }
    const payload = { project_id: String(project.id), ...(associate ? { budget_id: String(before.id) } : {}), ...body };
    return replayPgMutation(client, req, { operation: associate ? 'project.budget.associate' : 'project.budget.create', payload }, async () => {
      if (associate && before.version !== body.expected_version) throw new ApiError('VERSION_CONFLICT', '예산이 변경되었습니다. 새로고침하세요.');
      const budget = associate ? (await client.query('UPDATE accounting.budgets SET project_id=$3,version=version+1 WHERE company_id=$1 AND id=$2 RETURNING *', [p.companyId, before.id, project.id])).rows[0]
        : (await client.query(`INSERT INTO accounting.budgets(company_id,project_id,name,amount,money_currency,account_id,status) VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING *`, [p.companyId, project.id, body.name, body.amount, body.currency, body.account_id ?? null])).rows[0];
      await recordEvent(client, req, 'budgets', budget.id, before ?? null, budget);
      return { id: String(budget.id), project_id: String(project.id), version: budget.version };
    });
  });
}
