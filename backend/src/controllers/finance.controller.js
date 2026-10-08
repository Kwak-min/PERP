import { z } from "zod";

import { db, transaction } from "../config/db.js";
import { freshReceiptPrincipal, legacyReceiptParent } from '../services/legacy-receipt-files.service.js';
import { legacyMoneyLinks, requireProjectMoneyScope } from '../services/project-money-links.service.js';
import { resolvePrincipal } from "../middleware/auth.js";
import { bumpVersion, getScoped, insert, listScoped, nowIso, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { createApproval } from "../services/approval.service.js";
import { notify } from "../services/notification.service.js";
import { ApiError, notFound } from "../utils/errors.js";
import { txView, assertLegacyPeriodOpen as assertPeriodOpen, withLegacyFinanceTransaction, replayLegacyMutation, writeLegacyTransaction } from '../services/legacy-expenses.service.js';

const TX = "transaction_record";

const accountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().default("expense"),
});

const txSchema = z.object({
  kind: z.enum(["income", "expense"]),
  amount_minor: z.number().int().positive().safe(),
  occurred_on: z.string().date(),
  account_id: z.string().nullable().optional(),
  counterparty_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  budget_id: z.string().nullable().optional(),
  memo: z.string().default(""),
}).strict('Use /finance/expenses for expense fields.');

const txPatchSchema = z.object({
  amount_minor: z.number().int().optional(),
  memo: z.string().optional(),
  account_id: z.string().optional(),
  budget_id: z.string().optional(),
  version: z.number().int().optional(),
});

const budgetSchema = z.object({
  name: z.string().min(1),
  amount_minor: z.number().int().nonnegative(),
  period: z.string().default("FY"),
  department_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  account_id: z.string().nullable().optional(),
  over_policy: z.enum(["warn", "block"]).default("warn"),
});

const duesRuleSchema = z.object({
  name: z.string().min(1),
  amount_minor: z.number().int().nonnegative(),
  cycle: z.string().default("semester"),
});

const duesChargeSchema = z.object({
  rule_id: z.string(),
  payer_ids: z.array(z.string()),
  due_on: z.string(),
});

const duesPaySchema = z.object({
  amount_minor: z.number().int().positive(),
  paid_on: z.string(),
  method: z.string().default("transfer"),
});

const settlementSchema = z.object({
  title: z.string().min(1),
  amount_minor: z.number().int().positive(),
  project_id: z.string().nullable().optional(),
  budget_id: z.string().nullable().optional(),
  account_id: z.string().nullable().optional(),
  approver_id: z.string(),
});

const closeSchema = z.object({ period: z.string().length(7) });
const reopenSchema = z.object({
  period: z.string().length(7),
  approver_id: z.string(),
  reason: z.string().default(""),
});

function confirmedExpenseFor(principal, budgetId) {
  return db()
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM ${TX}
       WHERE tenant_id = ? AND org_id = ? AND budget_id = ?
         AND kind = 'expense' AND status = 'confirmed' AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, budgetId).total;
}

function budgetWarning(principal, tx) {
  if (!tx.budget_id || tx.kind !== "expense") return null;
  const budget = db().prepare("SELECT * FROM budget WHERE id = ?").get(tx.budget_id);
  if (!budget) return null;
  const spent = confirmedExpenseFor(principal, budget.id);
  if (spent > budget.amount_minor) {
    return {
      budget_id: budget.id,
      policy: budget.over_policy,
      spent_minor: spent,
      amount_minor: budget.amount_minor,
    };
  }
  return null;
}

export function createAccount(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.write");
  const payload = accountSchema.parse(req.body);
  const account = insert("account", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    code: payload.code,
    name: payload.name,
    kind: payload.kind,
    created_by: principal.userId,
  });
  res.status(201).json({ id: account.id, code: account.code, name: account.name, kind: account.kind });
}

export function listAccounts(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const rows = listScoped("account", principal, [{ sql: "active = 1", params: [] }], { limit: 500, orderBy: "code ASC" });
  res.json({ items: rows.map((a) => ({ id: a.id, code: a.code, name: a.name, kind: a.kind })) });
}

export function createTransaction(req, res) {
  const payload = txSchema.parse(req.body);
  const result = withLegacyFinanceTransaction(req, principal => replayLegacyMutation(req, principal,
    { operation: 'transaction.create', payload, keyRequired: false }, () => {
      const tx = writeLegacyTransaction(principal, payload, req.requestId);
      return { ...tx, budget_warning: budgetWarning(principal, tx) };
    }));
  res.status(201).json(result);
}

export function listTransactions(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const filters = [];
  if (req.query.status) filters.push({ sql: "status = ?", params: [req.query.status] });
  if (req.query.project_id) filters.push({ sql: "project_id = ?", params: [req.query.project_id] });
  const rows = listScoped(TX, principal, filters, { limit: Number(req.query.limit ?? 100) });
  res.json({ items: rows.map(txView), next_cursor: null });
}

export function patchTransaction(req, res) {
  const result = transaction(() => {
  const principal = freshReceiptPrincipal(resolvePrincipal(req), 'transaction');
  principal.require("transaction.write");
  const payload = txPatchSchema.parse(req.body);
  const tx = legacyReceiptParent(principal, { kind: 'transaction', parentId: req.params.transactionId, write: true });
  assertPeriodOpen(principal, tx.occurred_on);
  if (tx.status === 'confirmed') throw new ApiError('CONFLICT', '확정된 금융 기록은 덮어쓸 수 없습니다.');

  if (payload.version !== undefined && payload.version !== tx.version) {
    throw new ApiError("VERSION_CONFLICT", "transaction was modified by someone else");
  }

  const before = txView(tx);
  const changes = {};
  for (const field of ["amount_minor", "memo", "account_id", "budget_id"]) {
    if (payload[field] !== undefined) changes[field] = payload[field];
  }
  const links = legacyMoneyLinks(principal, { ...tx, ...changes });
  if (payload.budget_id !== undefined) changes.project_id = links.projectId;
  const updated = bumpVersion(TX, tx, changes, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "transaction.updated",
    resourceType: "transaction",
    resourceId: tx.id,
    actorId: principal.userId,
    before,
    after: txView(updated),
    requestId: req.requestId,
  });

  return txView(updated);
  })();
  res.json(result);
}

export function confirmTransaction(req, res) {
  const result = transaction(() => {
  const principal = freshReceiptPrincipal(resolvePrincipal(req), 'transaction');
  principal.require("transaction.confirm");
  const tx = getScoped(TX, principal, req.params.transactionId, "transaction");
  if (principal.scope !== 'all' && tx.created_by !== principal.userId) throw notFound('transaction');
  legacyMoneyLinks(principal, tx);
  assertPeriodOpen(principal, tx.occurred_on);
  if (tx.status === "confirmed") throw new ApiError("CONFLICT", "transaction already confirmed");

  const before = txView(tx);
  const updated = bumpVersion(TX, tx, { status: "confirmed" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "transaction.confirmed",
    resourceType: "transaction",
    resourceId: tx.id,
    actorId: principal.userId,
    before,
    after: txView(updated),
    requestId: req.requestId,
  });

  return { ...txView(updated), budget_warning: budgetWarning(principal, updated) };
  })();
  res.json(result);
}

export function createBudget(req, res) {
  const result = transaction(() => {
  const principal = freshReceiptPrincipal(resolvePrincipal(req), 'transaction');
  principal.require("budget.write");
  const payload = budgetSchema.parse(req.body);
  if (payload.project_id) requireProjectMoneyScope(principal, getScoped('project', principal, payload.project_id));
  if (payload.account_id) getScoped('account', principal, payload.account_id);
  const budget = insert("budget", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    amount_minor: payload.amount_minor,
    period: payload.period,
    department_id: payload.department_id ?? null,
    project_id: payload.project_id ?? null,
    account_id: payload.account_id ?? null,
    over_policy: payload.over_policy,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "budget.created",
    resourceType: "budget",
    resourceId: budget.id,
    actorId: principal.userId,
    after: { name: budget.name, amount_minor: budget.amount_minor },
    requestId: req.requestId,
  });

  return {
    id: budget.id,
    name: budget.name,
    amount_minor: budget.amount_minor,
    revision: budget.revision,
  };
  })();
  res.status(201).json(result);
}

export function listBudgets(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("budget.read");
  const rows = listScoped("budget", principal, [], { limit: 200 });
  res.json({
    items: rows.map((b) => {
      const spent = confirmedExpenseFor(principal, b.id);
      return {
        id: b.id,
        name: b.name,
        period: b.period,
        amount_minor: b.amount_minor,
        spent_minor: spent,
        execution_rate: b.amount_minor ? Math.round((1000 * spent) / b.amount_minor) / 10 : 0,
        over: spent > b.amount_minor,
        over_policy: b.over_policy,
        revision: b.revision,
      };
    }),
    formula: "집행률 = 확정 지출 합계 / 승인 예산",
  });
}

export function createDuesRule(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const payload = duesRuleSchema.parse(req.body);
  const rule = insert("dues_rule", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    amount_minor: payload.amount_minor,
    cycle: payload.cycle,
    created_by: principal.userId,
  });
  res.status(201).json({ id: rule.id, name: rule.name, amount_minor: rule.amount_minor });
}

export function createDuesCharges(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const payload = duesChargeSchema.parse(req.body);
  const rule = getScoped("dues_rule", principal, payload.rule_id, "dues rule");

  const created = [];
  for (const payerId of payload.payer_ids) {
    const charge = insert("dues_charge", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      rule_id: rule.id,
      payer_id: payerId,
      amount_minor: rule.amount_minor,
      due_on: payload.due_on,
      created_by: principal.userId,
    });
    created.push(charge.id);
    notify({
      tenantId: principal.tenantId,
      recipientId: payerId,
      type: "dues.charged",
      title: `회비가 청구되었습니다: ${rule.name}`,
      relatedType: "dues_charge",
      relatedId: charge.id,
      dedupeKey: `dues:${charge.id}`,
    });
  }
  res.status(201).json({ created, count: created.length });
}

export function listDuesCharges(req, res) {
  const principal = resolvePrincipal(req);
  let rows = listScoped("dues_charge", principal, [], { limit: 500 });
  if (!principal.has("dues.write")) rows = rows.filter((c) => c.payer_id === principal.userId);
  const paid = rows.filter((c) => c.status === "paid").length;
  res.json({
    items: rows.map((c) => ({
      id: c.id,
      payer_id: c.payer_id,
      amount_minor: c.amount_minor,
      due_on: c.due_on,
      status: c.status,
    })),
    payment_rate: rows.length ? Math.round((1000 * paid) / rows.length) / 10 : 0,
  });
}

export function payDues(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const payload = duesPaySchema.parse(req.body);
  const charge = getScoped("dues_charge", principal, req.params.chargeId, "dues charge");

  insert("dues_payment", {
    tenant_id: principal.tenantId,
    charge_id: charge.id,
    amount_minor: payload.amount_minor,
    paid_on: payload.paid_on,
    method: payload.method,
    created_by: principal.userId,
  });
  update("dues_charge", charge.id, { status: "paid" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "dues.paid",
    resourceType: "dues_charge",
    resourceId: charge.id,
    actorId: principal.userId,
    after: { amount_minor: payload.amount_minor },
    requestId: req.requestId,
  });

  res.json({ charge_id: charge.id, status: "paid" });
}

export function exemptDues(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const charge = getScoped("dues_charge", principal, req.params.chargeId, "dues charge");
  const reason = String(req.query.reason ?? "");
  update("dues_charge", charge.id, { status: "exempt", exempt_reason: reason }, principal.userId);
  res.json({ charge_id: charge.id, status: "exempt", reason });
}

export function createSettlement(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("settlement.create");
  const payload = settlementSchema.parse(req.body);

  const settlement = insert("settlement", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    requester_id: principal.userId,
    title: payload.title,
    amount_minor: payload.amount_minor,
    project_id: payload.project_id ?? null,
    budget_id: payload.budget_id ?? null,
    account_id: payload.account_id ?? null,
    created_by: principal.userId,
  });

  const approval = createApproval(principal, {
    title: `정산 요청: ${payload.title}`,
    steps: [{ approver_id: payload.approver_id }],
    formKey: "settlement",
    subjectType: "settlement",
    subjectId: settlement.id,
    amount: payload.amount_minor,
  });

  update("settlement", settlement.id, { approval_id: approval.id, status: "pending" }, principal.userId);

  res.status(201).json({
    id: settlement.id,
    status: "pending",
    approval_id: approval.id,
    amount_minor: settlement.amount_minor,
  });
}

export function postSettlement(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.confirm");
  const settlement = getScoped("settlement", principal, req.params.settlementId, "settlement");
  const approval = settlement.approval_id
    ? db().prepare("SELECT * FROM approval WHERE id = ?").get(settlement.approval_id)
    : null;

  if (!approval || approval.status !== "approved") {
    throw new ApiError("APPROVAL_REQUIRED", "settlement is not approved yet");
  }
  if (settlement.transaction_id) throw new ApiError("CONFLICT", "settlement already posted");

  const tx = insert(TX, {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    kind: "expense",
    amount_minor: settlement.amount_minor,
    occurred_on: nowIso().slice(0, 10),
    project_id: settlement.project_id,
    budget_id: settlement.budget_id,
    account_id: settlement.account_id,
    memo: settlement.title,
    status: "confirmed",
    approval_id: approval.id,
    created_by: principal.userId,
  });

  update("settlement", settlement.id, { transaction_id: tx.id, status: "posted" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "settlement.posted",
    resourceType: "settlement",
    resourceId: settlement.id,
    actorId: principal.userId,
    after: { transaction_id: tx.id },
    approvalId: approval.id,
    requestId: req.requestId,
  });

  res.json({ settlement_id: settlement.id, transaction_id: tx.id, status: "posted" });
}

export function ledger(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const period = req.query.period ?? null;
  let rows = listScoped(TX, principal, [{ sql: "status = ?", params: ["confirmed"] }], { limit: 10000 });
  if (period) rows = rows.filter((t) => t.occurred_on.startsWith(period));

  const byAccount = new Map();
  for (const tx of rows) {
    const key = tx.account_id ?? "unassigned";
    if (!byAccount.has(key)) byAccount.set(key, { account_id: key, income_minor: 0, expense_minor: 0 });
    const bucket = byAccount.get(key);
    if (tx.kind === "income") bucket.income_minor += tx.amount_minor;
    else bucket.expense_minor += tx.amount_minor;
  }

  const income = rows.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount_minor, 0);
  const expense = rows.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount_minor, 0);

  res.json({
    period,
    accounts: [...byAccount.values()],
    income_minor: income,
    expense_minor: expense,
    balance_minor: income - expense,
    transaction_count: rows.length,
  });
}

export function reportSummary(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const period = req.query.period ?? null;
  let rows = listScoped(TX, principal, [{ sql: "status = ?", params: ["confirmed"] }], { limit: 10000 });
  if (period) rows = rows.filter((t) => t.occurred_on.startsWith(period));

  const income = rows.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount_minor, 0);
  const expense = rows.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount_minor, 0);
  const budgets = listScoped("budget", principal, [], { limit: 200 });
  const budgetTotal = budgets.reduce((s, b) => s + b.amount_minor, 0);

  res.json({
    period,
    income_minor: income,
    expense_minor: expense,
    balance_minor: income - expense,
    budget_total_minor: budgetTotal,
    budget_execution_rate: budgetTotal ? Math.round((1000 * expense) / budgetTotal) / 10 : 0,
    unevidenced_count: rows.filter((t) => t.kind === "expense" && txView(t).evidence_count === 0).length,
    transaction_count: rows.length,
    formula: "수지 = 확정 수입 합계 - 확정 지출 합계",
    generated_from: "transaction(status=confirmed)",
  });
}

export function closePeriod(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("fiscal.close");
  const payload = closeSchema.parse(req.body);

  const existing = db()
    .prepare(
      `SELECT * FROM fiscal_period_lock
       WHERE tenant_id = ? AND org_id = ? AND period = ? AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, payload.period);
  if (existing && existing.status === "locked") {
    throw new ApiError("CONFLICT", "period already locked");
  }

  const lock = existing
    ? update(
        "fiscal_period_lock",
        existing.id,
        { status: "locked", locked_by: principal.userId, reopen_approval_id: null },
        principal.userId,
      )
    : insert("fiscal_period_lock", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        period: payload.period,
        status: "locked",
        locked_by: principal.userId,
        created_by: principal.userId,
      });

  audit.record({
    tenantId: principal.tenantId,
    action: "fiscal.closed",
    resourceType: "fiscal_period_lock",
    resourceId: lock.id,
    actorId: principal.userId,
    after: { period: lock.period, status: lock.status },
    requestId: req.requestId,
  });

  res.json({ period: lock.period, status: lock.status });
}

export function requestReopen(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("fiscal.reopen.request");
  const payload = reopenSchema.parse(req.body);

  const lock = db()
    .prepare(
      `SELECT * FROM fiscal_period_lock
       WHERE tenant_id = ? AND org_id = ? AND period = ? AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, payload.period);
  if (!lock || lock.status !== "locked") throw new ApiError("CONFLICT", "period is not locked");

  const approval = createApproval(principal, {
    title: `마감 재오픈 요청: ${payload.period}`,
    steps: [{ approver_id: payload.approver_id }],
    formKey: "fiscal_reopen",
    subjectType: "fiscal_period_lock",
    subjectId: lock.id,
    payload: { reason: payload.reason },
  });

  update("fiscal_period_lock", lock.id, { reopen_approval_id: approval.id }, principal.userId);
  res.json({ period: lock.period, approval_id: approval.id, status: lock.status });
}

export function reopenPeriod(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("fiscal.reopen.request");
  const payload = closeSchema.parse(req.body);

  const lock = db()
    .prepare(
      `SELECT * FROM fiscal_period_lock
       WHERE tenant_id = ? AND org_id = ? AND period = ? AND deleted_at IS NULL`,
    )
    .get(principal.tenantId, principal.orgId, payload.period);
  if (!lock) throw notFound("fiscal period lock");

  const approval = lock.reopen_approval_id
    ? db().prepare("SELECT * FROM approval WHERE id = ?").get(lock.reopen_approval_id)
    : null;
  if (!approval || approval.status !== "approved") {
    throw new ApiError("APPROVAL_REQUIRED", "reopen requires an approved request");
  }

  const updated = update("fiscal_period_lock", lock.id, { status: "open" }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "fiscal.reopened",
    resourceType: "fiscal_period_lock",
    resourceId: lock.id,
    actorId: principal.userId,
    after: { period: updated.period, status: updated.status },
    approvalId: approval.id,
    requestId: req.requestId,
  });

  res.json({ period: updated.period, status: updated.status });
}

export function listLocks(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const rows = listScoped("fiscal_period_lock", principal, [], { limit: 200 });
  res.json({
    items: rows.map((l) => ({
      period: l.period,
      status: l.status,
      reopen_approval_id: l.reopen_approval_id,
    })),
  });
}
