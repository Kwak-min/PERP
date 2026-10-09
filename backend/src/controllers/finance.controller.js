import { z } from "zod";

import { pgQuery, pgTransaction } from "../config/pg.js";
import { resolvePrincipal } from "../middleware/auth.js";
import * as audit from "../services/audit.service.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(accounting.*) 전용 재무 컨트롤러.
// SQLite(config/db, models/base, node:sqlite)를 전혀 쓰지 않는다.
// 모든 조회/쓰기는 company_id = principal.orgId 로 스코프.
//
// ── 복식부기 매핑(핵심) ─────────────────────────────────────
// perp_db 에는 프론트가 다루는 "거래(income/expense 단건)" 테이블이 없고
// accounting.journal_entries(+journal_lines) 뿐이다. 그래서 거래 1건을
// journal_entry 1건(+ 2개의 balanced line)으로 표현한다.
//   · 수입(income):  차변 현금(asset)  / 대변 손익계정(revenue)
//   · 지출(expense): 차변 손익계정(expense) / 대변 현금(asset)
// (기존 시드 데이터의 관례를 그대로 따른다.)
// 읽을 때는 각 entry 의 "대표 라인"(account_type ∈ revenue/expense)을 골라
//   kind       = revenue → income, expense → expense
//   account_id = 대표 라인의 account_id
//   amount     = 대표 라인의 debit+credit (한쪽은 0)
// 로 역산한다. 프론트의 ledger 재집계(거래합계 == 원장합계)는 대표 라인만
// 쓰므로 현금 상계 라인이 있어도 항상 일치한다.
//
// ── 금액 규칙 ───────────────────────────────────────────────
// 원화(KRW)는 보조단위가 없어 amount_minor(정수) == numeric(원 단위) 1:1.
//   DB→프론트: amount_minor = Math.round(Number(numeric))
//   프론트→DB: numeric = amount_minor (그대로)
//
// ── 상태 매핑 ───────────────────────────────────────────────
//   거래 status: confirmed ↔ journal_entries.posted=true, draft ↔ posted=false
//   회비 exempt(프론트) ↔ dues_charges.status='waived'(DB)
//   정산/마감 승인: org.approval_requests 로 직접 생성(approval.service 미사용)
//   마감: accounting.fiscal_periods.is_closed
//
// ── DB 제약(직접 확인하여 반영) ─────────────────────────────
//   accounts.account_type ∈ {asset,liability,equity,revenue,expense}
//   journal: posting 시 line>=2 && sum(debit)=sum(credit)>0 (check_daily_journal)
//   posted 전표/라인은 수정·삭제 불가 (draft 일 때만 patch 가능)
//   budgets.amount > 0, dues_rules.cycle ∈ {once,monthly,quarterly,yearly}
//   dues_charges.status ∈ {unpaid,partial,paid,waived,overdue}
//   settlements.status / approval_requests.status = common.approval_status
//     ∈ {pending,approved,rejected,draft,withdrawn}

const CURRENCY = "KRW";
const toMinor = (numeric) => Math.round(Number(numeric ?? 0));

// ── zod 스키마 ──────────────────────────────────────────────
const accountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().default("expense"),
});

const txSchema = z.object({
  kind: z.enum(["income", "expense"]),
  amount_minor: z.number().int().positive(),
  occurred_on: z.string().length(10),
  account_id: z.string().nullable().optional(),
  counterparty_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  budget_id: z.string().nullable().optional(),
  memo: z.string().default(""),
});

const txPatchSchema = z.object({
  amount_minor: z.number().int().positive().optional(),
  memo: z.string().optional(),
  account_id: z.string().optional(),
  budget_id: z.string().optional(),
  version: z.number().int().optional(),
});

const budgetSchema = z.object({
  name: z.string().min(1),
  amount_minor: z.number().int().positive(),
  period: z.string().default("FY"),
  department_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  account_id: z.string().nullable().optional(),
  over_policy: z.enum(["warn", "block"]).default("warn"),
});

const duesRuleSchema = z.object({
  name: z.string().min(1),
  amount_minor: z.number().int().positive(),
  cycle: z.enum(["once", "monthly", "quarterly", "yearly"]).default("monthly"),
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

// ── 공용 헬퍼 ───────────────────────────────────────────────
async function recordAudit(entry) {
  try {
    audit.record(entry);
  } catch {
    // 레거시 감사 로그(SQLite) 실패는 무시한다. 요청은 계속 성공.
  }
}

// account_type(DB) → kind(프론트)
const kindOfAccountType = (t) =>
  t === "revenue" ? "income" : t === "expense" ? "expense" : t;

// 회사 범위의 현금(상계) 계정 id 를 확보한다(없으면 생성). exceptId 와는 다른 계정.
async function ensureCashAccount(client, orgId, exceptId) {
  const sel = await client.query(
    `SELECT id FROM accounting.accounts
      WHERE company_id::text = $1 AND account_type = 'asset' AND is_active = true
        AND ($2::bigint IS NULL OR id <> $2::bigint)
      ORDER BY code ASC LIMIT 1`,
    [orgId, exceptId ?? null],
  );
  if (sel.rows[0]) return sel.rows[0].id;
  const ins = await client.query(
    `INSERT INTO accounting.accounts (company_id, code, name, account_type, is_active)
     VALUES ($1::bigint, '1000', '현금', 'asset', true)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [orgId],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const again = await client.query(
    `SELECT id FROM accounting.accounts
      WHERE company_id::text = $1 AND account_type = 'asset' ORDER BY code ASC LIMIT 1`,
    [orgId],
  );
  return again.rows[0]?.id ?? null;
}

// 거래의 손익(대표) 계정 id 를 확보한다. account_id 가 오면 회사 소속 검증,
// 없으면 kind 에 맞는 계정을 찾고 없으면 생성.
async function ensurePlAccount(client, orgId, kind, accountId) {
  if (accountId != null && accountId !== "") {
    const { rows } = await client.query(
      `SELECT id FROM accounting.accounts WHERE id::text = $1 AND company_id::text = $2`,
      [String(accountId), orgId],
    );
    if (rows.length === 0) throw notFound("account");
    return rows[0].id;
  }
  const wantType = kind === "income" ? "revenue" : "expense";
  const sel = await client.query(
    `SELECT id FROM accounting.accounts
      WHERE company_id::text = $1 AND account_type = $2 AND is_active = true
      ORDER BY code ASC LIMIT 1`,
    [orgId, wantType],
  );
  if (sel.rows[0]) return sel.rows[0].id;
  const code = kind === "income" ? "4900" : "5900";
  const name = kind === "income" ? "기타수입" : "기타지출";
  const ins = await client.query(
    `INSERT INTO accounting.accounts (company_id, code, name, account_type, is_active)
     VALUES ($1::bigint, $2, $3, $4, true)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [orgId, code, name, wantType],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const again = await client.query(
    `SELECT id FROM accounting.accounts
      WHERE company_id::text = $1 AND account_type = $2 ORDER BY code ASC LIMIT 1`,
    [orgId, wantType],
  );
  return again.rows[0].id;
}

// 마감(is_closed)된 회계기간이면 차단.
async function assertPeriodOpen(orgId, occurredOn) {
  const { rows } = await pgQuery(
    `SELECT name FROM accounting.fiscal_periods
      WHERE company_id::text = $1 AND $2::date BETWEEN starts_on AND ends_on AND is_closed = true
      LIMIT 1`,
    [orgId, occurredOn],
  );
  if (rows.length > 0) {
    throw new ApiError(
      "PERIOD_LOCKED",
      `회계기간 '${rows[0].name}' 이(가) 마감되어 전표를 변경할 수 없습니다; 재오픈 결재가 필요합니다`,
    );
  }
}

// 거래(journal_entry) 1건을 프론트 형태로 조회하는 SELECT.
// pl = 대표 손익 라인(없으면 첫 라인) 을 LATERAL 로 1건 뽑는다.
const TX_SELECT = `
  SELECT je.id,
         to_char(je.entry_date, 'YYYY-MM-DD') AS occurred_on,
         je.memo, je.posted, je.budget_id, je.project_id, je.counterparty,
         je.input_currency, je.version,
         pl.account_id, pl.kind, pl.amount,
         (SELECT COUNT(*) FROM accounting.journal_entry_files f WHERE f.entry_id = je.id)
           AS evidence_count
    FROM accounting.journal_entries je
    LEFT JOIN LATERAL (
      SELECT jl.account_id,
             CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE 'expense' END AS kind,
             (jl.debit + jl.credit) AS amount
        FROM accounting.journal_lines jl
        JOIN accounting.accounts a ON a.id = jl.account_id
       WHERE jl.entry_id = je.id
       ORDER BY CASE WHEN a.account_type IN ('revenue', 'expense') THEN 0 ELSE 1 END, jl.id
       LIMIT 1
    ) pl ON true`;

const txView = (t) => ({
  id: String(t.id),
  kind: t.kind ?? "expense",
  account_id: t.account_id != null ? String(t.account_id) : null,
  counterparty_id: null,
  project_id: t.project_id != null ? String(t.project_id) : null,
  budget_id: t.budget_id != null ? String(t.budget_id) : null,
  amount_minor: toMinor(t.amount),
  currency: t.input_currency ?? CURRENCY,
  occurred_on: t.occurred_on,
  memo: t.memo ?? "",
  status: t.posted ? "confirmed" : "draft",
  approval_id: null,
  evidence_count: Number(t.evidence_count ?? 0),
  ai_generated: false,
  version: t.version,
});

async function loadTx(orgId, entryId) {
  const { rows } = await pgQuery(`${TX_SELECT} WHERE je.id::text = $1 AND je.company_id::text = $2`, [
    String(entryId),
    orgId,
  ]);
  if (rows.length === 0) throw notFound("transaction");
  return rows[0];
}

// ── 계정과목 ────────────────────────────────────────────────
export async function createAccount(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.write");
  const payload = accountSchema.parse(req.body);
  const allowed = ["asset", "liability", "equity", "revenue", "expense"];
  let accountType =
    payload.kind === "income" ? "revenue" : payload.kind === "expense" ? "expense" : payload.kind;
  if (!allowed.includes(accountType)) accountType = "expense";

  const { rows } = await pgQuery(
    `INSERT INTO accounting.accounts (company_id, code, name, account_type, is_active)
     VALUES ($1::bigint, $2, $3, $4, true)
     RETURNING id, code, name, account_type`,
    [principal.orgId, payload.code, payload.name, accountType],
  );
  const a = rows[0];
  res.status(201).json({
    id: String(a.id),
    code: a.code,
    name: a.name,
    kind: kindOfAccountType(a.account_type),
  });
}

export async function listAccounts(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const { rows } = await pgQuery(
    `SELECT id, code, name, account_type FROM accounting.accounts
      WHERE company_id::text = $1 AND is_active = true
      ORDER BY code ASC LIMIT 500`,
    [principal.orgId],
  );
  res.json({
    items: rows.map((a) => ({
      id: String(a.id),
      code: a.code,
      name: a.name,
      kind: kindOfAccountType(a.account_type),
    })),
  });
}

// ── 거래(전표) ──────────────────────────────────────────────
export async function createTransaction(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.write");
  const payload = txSchema.parse(req.body);
  await assertPeriodOpen(principal.orgId, payload.occurred_on);

  const amount = payload.amount_minor; // KRW 1:1

  const entry = await pgTransaction(async (client) => {
    const plAccountId = await ensurePlAccount(
      client,
      principal.orgId,
      payload.kind,
      payload.account_id,
    );
    const cashAccountId = await ensureCashAccount(client, principal.orgId, plAccountId);

    const { rows } = await client.query(
      `INSERT INTO accounting.journal_entries
         (company_id, entry_date, memo, created_by, posted, budget_id, project_id,
          counterparty, occurred_at)
       VALUES ($1::bigint, $2::date, $3, $4::bigint, false, $5, $6, $7, $2::timestamptz)
       RETURNING id`,
      [
        principal.orgId,
        payload.occurred_on,
        payload.memo,
        principal.userId,
        payload.budget_id ?? null,
        payload.project_id ?? null,
        payload.counterparty_id ?? null,
      ],
    );
    const entryId = rows[0].id;

    // 복식부기 2라인(균형). 수입: 대변=손익/차변=현금, 지출: 차변=손익/대변=현금.
    const plDebit = payload.kind === "expense" ? amount : 0;
    const plCredit = payload.kind === "income" ? amount : 0;
    await client.query(
      `INSERT INTO accounting.journal_lines (entry_id, account_id, debit, credit, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [entryId, plAccountId, plDebit, plCredit, payload.memo || null],
    );
    await client.query(
      `INSERT INTO accounting.journal_lines (entry_id, account_id, debit, credit, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [entryId, cashAccountId, plCredit, plDebit, "현금 상계"],
    );
    return entryId;
  });

  const tx = txView(await loadTx(principal.orgId, entry));
  await recordAudit({
    tenantId: principal.tenantId,
    action: "transaction.created",
    resourceType: "transaction",
    resourceId: tx.id,
    actorId: principal.userId,
    after: tx,
    requestId: req.requestId,
  });

  res.status(201).json({ ...tx, duplicate_warning: null, budget_warning: null });
}

export async function listTransactions(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const clauses = ["je.company_id::text = $1"];
  const params = [principal.orgId];
  if (req.query.status === "confirmed" || req.query.status === "draft") {
    params.push(req.query.status === "confirmed");
    clauses.push(`je.posted = $${params.length}`);
  }
  if (req.query.project_id) {
    params.push(req.query.project_id);
    clauses.push(`je.project_id::text = $${params.length}`);
  }
  params.push(Number(req.query.limit ?? 100));
  const { rows } = await pgQuery(
    `${TX_SELECT} WHERE ${clauses.join(" AND ")}
      ORDER BY je.entry_date DESC, je.id DESC
      LIMIT $${params.length}`,
    params,
  );
  res.json({ items: rows.map(txView), next_cursor: null });
}

export async function patchTransaction(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.write");
  const payload = txPatchSchema.parse(req.body);
  const tx = await loadTx(principal.orgId, req.params.transactionId);
  await assertPeriodOpen(principal.orgId, tx.occurred_on);

  if (tx.posted) {
    throw new ApiError("CONFLICT", "확정된 전표는 수정할 수 없습니다");
  }
  if (payload.version !== undefined && payload.version !== tx.version) {
    throw new ApiError("VERSION_CONFLICT", "transaction was modified by someone else");
  }

  const before = txView(tx);
  await pgTransaction(async (client) => {
    // memo / budget_id 변경은 entry 에.
    const sets = [];
    const p = [];
    if (payload.memo !== undefined) {
      p.push(payload.memo);
      sets.push(`memo = $${p.length}`);
    }
    if (payload.budget_id !== undefined) {
      p.push(payload.budget_id || null);
      sets.push(`budget_id = $${p.length}`);
    }
    if (sets.length > 0) {
      sets.push("version = version + 1");
      p.push(tx.id);
      await client.query(
        `UPDATE accounting.journal_entries SET ${sets.join(", ")} WHERE id = $${p.length}`,
        p,
      );
    } else {
      await client.query(
        `UPDATE accounting.journal_entries SET version = version + 1 WHERE id = $1`,
        [tx.id],
      );
    }

    // 금액 변경: 두 라인의 0 이 아닌 쪽을 새 금액으로.
    if (payload.amount_minor !== undefined) {
      const amt = payload.amount_minor;
      await client.query(
        `UPDATE accounting.journal_lines
            SET debit = CASE WHEN debit > 0 THEN $2 ELSE 0 END,
                credit = CASE WHEN credit > 0 THEN $2 ELSE 0 END
          WHERE entry_id = $1`,
        [tx.id, amt],
      );
    }

    // 대표(손익) 계정 변경.
    if (payload.account_id !== undefined && payload.account_id) {
      const chk = await client.query(
        `SELECT id FROM accounting.accounts WHERE id::text = $1 AND company_id::text = $2`,
        [String(payload.account_id), principal.orgId],
      );
      if (chk.rows.length === 0) throw notFound("account");
      await client.query(
        `UPDATE accounting.journal_lines jl
            SET account_id = $3
           FROM accounting.accounts a
          WHERE jl.entry_id = $1 AND jl.account_id = $2::bigint`,
        [tx.id, tx.account_id, payload.account_id],
      );
    }
  });

  const updated = txView(await loadTx(principal.orgId, tx.id));
  await recordAudit({
    tenantId: principal.tenantId,
    action: "transaction.updated",
    resourceType: "transaction",
    resourceId: updated.id,
    actorId: principal.userId,
    before,
    after: updated,
    requestId: req.requestId,
  });
  res.json(updated);
}

export async function confirmTransaction(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.confirm");
  const tx = await loadTx(principal.orgId, req.params.transactionId);
  await assertPeriodOpen(principal.orgId, tx.occurred_on);
  if (tx.posted) throw new ApiError("CONFLICT", "transaction already confirmed");

  const before = txView(tx);
  // posting 시 check_daily_journal 트리거가 라인 균형(>=2, 차=대>0)을 검증한다.
  const { rows } = await pgQuery(
    `UPDATE accounting.journal_entries
        SET posted = true, version = version + 1
      WHERE id = $1 AND company_id::text = $2 AND posted = false
      RETURNING id`,
    [tx.id, principal.orgId],
  );
  if (rows.length === 0) throw new ApiError("CONFLICT", "transaction already confirmed");

  const updated = txView(await loadTx(principal.orgId, tx.id));
  await recordAudit({
    tenantId: principal.tenantId,
    action: "transaction.confirmed",
    resourceType: "transaction",
    resourceId: updated.id,
    actorId: principal.userId,
    before,
    after: updated,
    requestId: req.requestId,
  });
  res.json({ ...updated, budget_warning: null });
}

// ── 예산 ────────────────────────────────────────────────────
// 집행(spent)은 budgets.spent 컬럼 대신, 해당 budget_id 로 연결된 "확정(posted)
// 지출 전표"의 지출계정 차변 합계로 동적 계산한다(구 SQLite 동작과 동일 의미).
const BUDGET_SELECT = `
  SELECT b.id, b.name, b.amount, b.status, b.version,
         fp.name AS period_name,
         COALESCE((
           SELECT SUM(jl.debit)
             FROM accounting.journal_entries je
             JOIN accounting.journal_lines jl ON jl.entry_id = je.id
             JOIN accounting.accounts a ON a.id = jl.account_id
            WHERE je.budget_id = b.id AND je.posted = true AND a.account_type = 'expense'
         ), 0) AS spent_calc
    FROM accounting.budgets b
    LEFT JOIN accounting.fiscal_periods fp ON fp.id = b.period_id`;

const budgetView = (b) => {
  const amount = toMinor(b.amount);
  const spent = toMinor(b.spent_calc);
  return {
    id: String(b.id),
    name: b.name,
    period: b.period_name ?? "FY",
    amount_minor: amount,
    spent_minor: spent,
    execution_rate: amount ? Math.round((1000 * spent) / amount) / 10 : 0,
    over: spent > amount,
    over_policy: "warn",
    revision: b.version,
  };
};

export async function createBudget(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("budget.write");
  const payload = budgetSchema.parse(req.body);

  // 현재 날짜가 속한 회계기간을 연결(없으면 null).
  const { rows: periodRows } = await pgQuery(
    `SELECT id FROM accounting.fiscal_periods
      WHERE company_id::text = $1 AND CURRENT_DATE BETWEEN starts_on AND ends_on
      ORDER BY starts_on DESC LIMIT 1`,
    [principal.orgId],
  );
  const periodId = periodRows[0]?.id ?? null;

  const { rows } = await pgQuery(
    `INSERT INTO accounting.budgets
       (company_id, period_id, name, account_id, amount, status, project_id, money_currency)
     VALUES ($1::bigint, $2, $3, $4, $5, 'active', $6, 'KRW')
     RETURNING id, name, amount, version`,
    [
      principal.orgId,
      periodId,
      payload.name,
      payload.account_id ?? null,
      payload.amount_minor,
      payload.project_id ?? null,
    ],
  );
  const b = rows[0];
  await recordAudit({
    tenantId: principal.tenantId,
    action: "budget.created",
    resourceType: "budget",
    resourceId: String(b.id),
    actorId: principal.userId,
    after: { name: b.name, amount_minor: toMinor(b.amount) },
    requestId: req.requestId,
  });
  res.status(201).json({
    id: String(b.id),
    name: b.name,
    amount_minor: toMinor(b.amount),
    revision: b.version,
  });
}

export async function listBudgets(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("budget.read");
  const { rows } = await pgQuery(
    `${BUDGET_SELECT} WHERE b.company_id::text = $1 ORDER BY b.id DESC LIMIT 200`,
    [principal.orgId],
  );
  res.json({
    items: rows.map(budgetView),
    formula: "집행률 = 확정 지출 합계 / 승인 예산",
  });
}

// ── 회비 ────────────────────────────────────────────────────
export async function createDuesRule(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const payload = duesRuleSchema.parse(req.body);
  const { rows } = await pgQuery(
    `INSERT INTO accounting.dues_rules (company_id, name, amount, cycle, is_active)
     VALUES ($1::bigint, $2, $3, $4, true)
     RETURNING id, name, amount`,
    [principal.orgId, payload.name, payload.amount_minor, payload.cycle],
  );
  const r = rows[0];
  res.status(201).json({ id: String(r.id), name: r.name, amount_minor: toMinor(r.amount) });
}

export async function createDuesCharges(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const payload = duesChargeSchema.parse(req.body);

  const { rows: ruleRows } = await pgQuery(
    `SELECT id, name, amount FROM accounting.dues_rules
      WHERE id::text = $1 AND company_id::text = $2`,
    [payload.rule_id, principal.orgId],
  );
  if (ruleRows.length === 0) throw notFound("dues rule");
  const rule = ruleRows[0];

  const created = [];
  for (const payerId of payload.payer_ids) {
    const { rows } = await pgQuery(
      `INSERT INTO accounting.dues_charges
         (company_id, rule_id, target_user_id, amount, due_date, status)
       VALUES ($1::bigint, $2, $3, $4, $5::date, 'unpaid')
       RETURNING id`,
      [principal.orgId, rule.id, payerId, toMinor(rule.amount), payload.due_on],
    );
    created.push(String(rows[0].id));
  }
  res.status(201).json({ created, count: created.length });
}

export async function listDuesCharges(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.read");
  const canWrite = principal.has("dues.write");
  const clauses = ["company_id::text = $1"];
  const params = [principal.orgId];
  if (!canWrite) {
    params.push(principal.userId);
    clauses.push(`target_user_id::text = $${params.length}`);
  }
  const { rows } = await pgQuery(
    `SELECT id, target_user_id, amount, to_char(due_date, 'YYYY-MM-DD') AS due_on, status
       FROM accounting.dues_charges
      WHERE ${clauses.join(" AND ")}
      ORDER BY id DESC LIMIT 500`,
    params,
  );
  const paid = rows.filter((c) => c.status === "paid").length;
  res.json({
    items: rows.map((c) => ({
      id: String(c.id),
      payer_id: c.target_user_id != null ? String(c.target_user_id) : null,
      amount_minor: toMinor(c.amount),
      due_on: c.due_on,
      status: c.status,
    })),
    payment_rate: rows.length ? Math.round((1000 * paid) / rows.length) / 10 : 0,
  });
}

export async function payDues(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const payload = duesPaySchema.parse(req.body);

  const { rows: chargeRows } = await pgQuery(
    `SELECT id FROM accounting.dues_charges WHERE id::text = $1 AND company_id::text = $2`,
    [req.params.chargeId, principal.orgId],
  );
  if (chargeRows.length === 0) throw notFound("dues charge");
  const chargeId = chargeRows[0].id;

  await pgTransaction(async (client) => {
    await client.query(
      `INSERT INTO accounting.dues_payments (charge_id, amount, paid_on, method, recorded_by)
       VALUES ($1, $2, $3::date, $4, $5::bigint)`,
      [chargeId, payload.amount_minor, payload.paid_on, payload.method, principal.userId],
    );
    await client.query(
      `UPDATE accounting.dues_charges SET status = 'paid', version = version + 1 WHERE id = $1`,
      [chargeId],
    );
  });
  res.json({ charge_id: String(chargeId), status: "paid" });
}

export async function exemptDues(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("dues.write");
  const reason = String(req.query.reason ?? "");
  // 프론트 'exempt' ↔ DB 'waived'
  const { rows } = await pgQuery(
    `UPDATE accounting.dues_charges SET status = 'waived', version = version + 1
      WHERE id::text = $1 AND company_id::text = $2
      RETURNING id`,
    [req.params.chargeId, principal.orgId],
  );
  if (rows.length === 0) throw notFound("dues charge");
  res.json({ charge_id: String(rows[0].id), status: "exempt", reason });
}

// ── 정산 ────────────────────────────────────────────────────
export async function createSettlement(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("settlement.create");
  const payload = settlementSchema.parse(req.body);

  const result = await pgTransaction(async (client) => {
    const { rows: sRows } = await client.query(
      `INSERT INTO accounting.settlements (company_id, requester_id, title, amount, status)
       VALUES ($1::bigint, $2::bigint, $3, $4, 'pending')
       RETURNING id`,
      [principal.orgId, principal.userId, payload.title, payload.amount_minor],
    );
    const settlementId = sRows[0].id;

    // approval.service 대신 org.approval_requests 에 직접 생성.
    const body = {
      settlement_id: String(settlementId),
      amount_minor: payload.amount_minor,
      project_id: payload.project_id ?? null,
      budget_id: payload.budget_id ?? null,
      account_id: payload.account_id ?? null,
    };
    const { rows: aRows } = await client.query(
      `INSERT INTO org.approval_requests
         (company_id, request_type, requester_id, target_user_id, title, form_key, payload, body, status)
       VALUES ($1::bigint, 'settlement', $2::bigint, $3::bigint, $4, 'settlement',
               $5::jsonb, $5::jsonb, 'pending')
       RETURNING id`,
      [
        principal.orgId,
        principal.userId,
        payload.approver_id,
        `정산 요청: ${payload.title}`,
        JSON.stringify(body),
      ],
    );
    return { settlementId, approvalId: aRows[0].id };
  });

  res.status(201).json({
    id: String(result.settlementId),
    status: "pending",
    approval_id: String(result.approvalId),
    amount_minor: payload.amount_minor,
  });
}

export async function postSettlement(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.confirm");

  const { rows: sRows } = await pgQuery(
    `SELECT id, title, amount, journal_entry_id
       FROM accounting.settlements WHERE id::text = $1 AND company_id::text = $2`,
    [req.params.settlementId, principal.orgId],
  );
  if (sRows.length === 0) throw notFound("settlement");
  const settlement = sRows[0];
  if (settlement.journal_entry_id) throw new ApiError("CONFLICT", "settlement already posted");

  const { rows: aRows } = await pgQuery(
    `SELECT id, status, body FROM org.approval_requests
      WHERE company_id::text = $1 AND request_type = 'settlement'
        AND (body->>'settlement_id') = $2
      ORDER BY id DESC LIMIT 1`,
    [principal.orgId, String(settlement.id)],
  );
  const approval = aRows[0];
  if (!approval || approval.status !== "approved") {
    throw new ApiError("APPROVAL_REQUIRED", "settlement is not approved yet");
  }

  const amount = toMinor(settlement.amount);
  const body = approval.body ?? {};

  const entryId = await pgTransaction(async (client) => {
    const plAccountId = await ensurePlAccount(
      client,
      principal.orgId,
      "expense",
      body.account_id ?? null,
    );
    const cashAccountId = await ensureCashAccount(client, principal.orgId, plAccountId);

    const { rows } = await client.query(
      `INSERT INTO accounting.journal_entries
         (company_id, entry_date, memo, created_by, posted, budget_id, project_id, occurred_at)
       VALUES ($1::bigint, CURRENT_DATE, $2, $3::bigint, false, $4, $5, now())
       RETURNING id`,
      [principal.orgId, settlement.title, principal.userId, body.budget_id ?? null, body.project_id ?? null],
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO accounting.journal_lines (entry_id, account_id, debit, credit, description)
       VALUES ($1, $2, $3, 0, $4)`,
      [id, plAccountId, amount, settlement.title],
    );
    await client.query(
      `INSERT INTO accounting.journal_lines (entry_id, account_id, debit, credit, description)
       VALUES ($1, $2, 0, $3, '현금 상계')`,
      [id, cashAccountId, amount],
    );
    await client.query(`UPDATE accounting.journal_entries SET posted = true WHERE id = $1`, [id]);
    await client.query(
      `UPDATE accounting.settlements
          SET journal_entry_id = $1, status = 'approved', decided_by = $2::bigint, decided_at = now()
        WHERE id = $3`,
      [id, principal.userId, settlement.id],
    );
    return id;
  });

  await recordAudit({
    tenantId: principal.tenantId,
    action: "settlement.posted",
    resourceType: "settlement",
    resourceId: String(settlement.id),
    actorId: principal.userId,
    after: { transaction_id: String(entryId) },
    requestId: req.requestId,
  });
  res.json({ settlement_id: String(settlement.id), transaction_id: String(entryId), status: "posted" });
}

// ── 원장 ────────────────────────────────────────────────────
export async function ledger(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const period = req.query.period ?? null;

  const params = [principal.orgId];
  let periodClause = "";
  if (period) {
    params.push(period);
    periodClause = ` AND to_char(je.entry_date, 'YYYY-MM') = $${params.length}`;
  }
  const { rows } = await pgQuery(
    `${TX_SELECT} WHERE je.company_id::text = $1 AND je.posted = true${periodClause}`,
    params,
  );

  const byAccount = new Map();
  let income = 0;
  let expense = 0;
  for (const r of rows) {
    const t = txView(r);
    const key = t.account_id ?? "unassigned";
    if (!byAccount.has(key))
      byAccount.set(key, { account_id: key, income_minor: 0, expense_minor: 0 });
    const bucket = byAccount.get(key);
    if (t.kind === "income") {
      bucket.income_minor += t.amount_minor;
      income += t.amount_minor;
    } else {
      bucket.expense_minor += t.amount_minor;
      expense += t.amount_minor;
    }
  }

  res.json({
    period,
    accounts: [...byAccount.values()],
    income_minor: income,
    expense_minor: expense,
    balance_minor: income - expense,
    transaction_count: rows.length,
  });
}

// ── 보고서 요약 ─────────────────────────────────────────────
export async function reportSummary(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const period = req.query.period ?? null;

  const params = [principal.orgId];
  let periodClause = "";
  if (period) {
    params.push(period);
    periodClause = ` AND to_char(je.entry_date, 'YYYY-MM') = $${params.length}`;
  }
  const { rows } = await pgQuery(
    `${TX_SELECT} WHERE je.company_id::text = $1 AND je.posted = true${periodClause}`,
    params,
  );
  const txs = rows.map(txView);
  const income = txs.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount_minor, 0);
  const expense = txs.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount_minor, 0);

  const { rows: bRows } = await pgQuery(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM accounting.budgets WHERE company_id::text = $1`,
    [principal.orgId],
  );
  const budgetTotal = toMinor(bRows[0].total);

  res.json({
    period,
    income_minor: income,
    expense_minor: expense,
    balance_minor: income - expense,
    budget_total_minor: budgetTotal,
    budget_execution_rate: budgetTotal ? Math.round((1000 * expense) / budgetTotal) / 10 : 0,
    unevidenced_count: txs.filter((t) => t.kind === "expense" && t.evidence_count === 0).length,
    transaction_count: txs.length,
    formula: "수지 = 확정 수입 합계 - 확정 지출 합계",
    generated_from: "journal_entries(posted=true)",
  });
}

// ── 결산(회계기간) ──────────────────────────────────────────
// perp_db fiscal_periods 는 연 단위 기간이다. period(YYYY-MM) 요청은 해당 월이
// 속한 회계기간을 찾아 is_closed 를 토글한다. 프론트에는 period(기간 시작월),
// locked(=is_closed), name 을 돌려준다.
export async function listLocks(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("transaction.read");
  const { rows } = await pgQuery(
    `SELECT id, name,
            to_char(starts_on, 'YYYY-MM') AS period,
            to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
            is_closed
       FROM accounting.fiscal_periods
      WHERE company_id::text = $1
      ORDER BY starts_on ASC LIMIT 200`,
    [principal.orgId],
  );
  res.json({
    items: rows.map((l) => ({
      period: l.period,
      name: l.name,
      starts_on: l.starts_on,
      ends_on: l.ends_on,
      locked: l.is_closed,
      locked_by: null,
      status: l.is_closed ? "locked" : "open",
      reopen_approval_id: null,
    })),
  });
}

async function findPeriodByMonth(orgId, periodYm) {
  const { rows } = await pgQuery(
    `SELECT id, name, is_closed FROM accounting.fiscal_periods
      WHERE company_id::text = $1 AND ($2 || '-01')::date BETWEEN starts_on AND ends_on
      ORDER BY starts_on DESC LIMIT 1`,
    [orgId, periodYm],
  );
  return rows[0] ?? null;
}

export async function closePeriod(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("fiscal.close");
  const payload = closeSchema.parse(req.body);

  const period = await findPeriodByMonth(principal.orgId, payload.period);
  if (!period) throw notFound("fiscal period");
  if (period.is_closed) throw new ApiError("CONFLICT", "period already locked");

  await pgQuery(`UPDATE accounting.fiscal_periods SET is_closed = true WHERE id = $1`, [period.id]);

  await recordAudit({
    tenantId: principal.tenantId,
    action: "fiscal.closed",
    resourceType: "fiscal_period",
    resourceId: String(period.id),
    actorId: principal.userId,
    after: { period: payload.period, status: "locked" },
    requestId: req.requestId,
  });
  res.json({ period: payload.period, locked: true, status: "locked", name: period.name });
}

export async function requestReopen(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("fiscal.reopen.request");
  const payload = reopenSchema.parse(req.body);

  const period = await findPeriodByMonth(principal.orgId, payload.period);
  if (!period || !period.is_closed) throw new ApiError("CONFLICT", "period is not locked");

  const body = { period: payload.period, fiscal_period_id: String(period.id), reason: payload.reason };
  const { rows } = await pgQuery(
    `INSERT INTO org.approval_requests
       (company_id, request_type, requester_id, target_user_id, title, form_key, payload, body, status)
     VALUES ($1::bigint, 'fiscal_reopen', $2::bigint, $3::bigint, $4, 'fiscal_reopen',
             $5::jsonb, $5::jsonb, 'pending')
     RETURNING id`,
    [
      principal.orgId,
      principal.userId,
      payload.approver_id,
      `마감 재오픈 요청: ${payload.period}`,
      JSON.stringify(body),
    ],
  );
  res.json({ period: payload.period, approval_id: String(rows[0].id), status: "locked" });
}

export async function reopenPeriod(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("fiscal.reopen.request");
  const payload = closeSchema.parse(req.body);

  const period = await findPeriodByMonth(principal.orgId, payload.period);
  if (!period) throw notFound("fiscal period");

  const { rows } = await pgQuery(
    `SELECT id, status FROM org.approval_requests
      WHERE company_id::text = $1 AND request_type = 'fiscal_reopen'
        AND (body->>'fiscal_period_id') = $2
      ORDER BY id DESC LIMIT 1`,
    [principal.orgId, String(period.id)],
  );
  const approval = rows[0];
  if (!approval || approval.status !== "approved") {
    throw new ApiError("APPROVAL_REQUIRED", "reopen requires an approved request");
  }

  await pgQuery(`UPDATE accounting.fiscal_periods SET is_closed = false WHERE id = $1`, [period.id]);

  await recordAudit({
    tenantId: principal.tenantId,
    action: "fiscal.reopened",
    resourceType: "fiscal_period",
    resourceId: String(period.id),
    actorId: principal.userId,
    after: { period: payload.period, status: "open" },
    requestId: req.requestId,
  });
  res.json({ period: payload.period, locked: false, status: "open" });
}
