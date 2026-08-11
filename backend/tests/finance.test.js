import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

describe("finance consistency and fiscal locks", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["approvals", "finance"]);
  });

  after(async () => {
    await server.close();
  });

  it("keeps drafts out and matches confirmed transactions, ledger, and report totals", async () => {
    // Given
    const income = await api(server.baseUrl, "/finance/transactions", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        kind: "income",
        amount_minor: 120_000,
        occurred_on: "2026-07-15",
        memo: "Dues",
      },
    });
    const expense = await api(server.baseUrl, "/finance/transactions", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        kind: "expense",
        amount_minor: 45_000,
        occurred_on: "2026-07-16",
        memo: "Venue",
      },
    });
    assert.equal(income.status, 201);
    assert.equal(expense.status, 201);

    const draftLedger = await api(server.baseUrl, "/finance/ledger?period=2026-07", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(draftLedger.body.transaction_count, 0);
    assert.equal(draftLedger.body.income_minor, 0);
    assert.equal(draftLedger.body.expense_minor, 0);

    // When
    for (const transaction of [income.body, expense.body]) {
      const confirmed = await api(
        server.baseUrl,
        `/finance/transactions/${transaction.id}/confirm`,
        {
          method: "POST",
          token: owner.token,
          orgId: owner.orgId,
        },
      );
      assert.equal(confirmed.status, 200);
    }

    // Then
    const transactions = await api(
      server.baseUrl,
      "/finance/transactions?status=confirmed",
      {
        token: owner.token,
        orgId: owner.orgId,
      },
    );
    const ledger = await api(server.baseUrl, "/finance/ledger?period=2026-07", {
      token: owner.token,
      orgId: owner.orgId,
    });
    const report = await api(
      server.baseUrl,
      "/finance/reports/summary?period=2026-07",
      {
        token: owner.token,
        orgId: owner.orgId,
      },
    );
    const totals = transactions.body.items.reduce(
      (sum, transaction) => ({
        income:
          sum.income + (transaction.kind === "income" ? transaction.amount_minor : 0),
        expense:
          sum.expense + (transaction.kind === "expense" ? transaction.amount_minor : 0),
      }),
      { income: 0, expense: 0 },
    );

    assert.deepEqual(totals, { income: 120_000, expense: 45_000 });
    assert.equal(ledger.body.income_minor, totals.income);
    assert.equal(ledger.body.expense_minor, totals.expense);
    assert.equal(report.body.income_minor, totals.income);
    assert.equal(report.body.expense_minor, totals.expense);
    assert.equal(ledger.body.balance_minor, report.body.balance_minor);
  });

  it("blocks a closed-period edit until an approved reopen completes", async () => {
    // Given
    const transaction = await api(server.baseUrl, "/finance/transactions", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        kind: "expense",
        amount_minor: 10_000,
        occurred_on: "2026-08-01",
        memo: "Before close",
      },
    });
    assert.equal(transaction.status, 201);
    const closed = await api(server.baseUrl, "/finance/close", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { period: "2026-08" },
    });
    assert.equal(closed.status, 200);

    const blocked = await api(
      server.baseUrl,
      `/finance/transactions/${transaction.body.id}`,
      {
        method: "PATCH",
        token: owner.token,
        orgId: owner.orgId,
        body: { memo: "Blocked" },
      },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "PERIOD_LOCKED");

    // When
    const request = await api(server.baseUrl, "/finance/close/reopen-request", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        period: "2026-08",
        approver_id: owner.userId,
        reason: "Correction",
      },
    });
    assert.equal(request.status, 200);
    const approved = await api(
      server.baseUrl,
      `/approvals/requests/${request.body.approval_id}/actions`,
      {
        method: "POST",
        token: owner.token,
        orgId: owner.orgId,
        body: { decision: "approve" },
      },
    );
    assert.equal(approved.status, 200);
    const reopened = await api(server.baseUrl, "/finance/close/reopen", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { period: "2026-08" },
    });
    assert.equal(reopened.status, 200);

    // Then
    const edited = await api(
      server.baseUrl,
      `/finance/transactions/${transaction.body.id}`,
      {
        method: "PATCH",
        token: owner.token,
        orgId: owner.orgId,
        body: { memo: "Corrected" },
      },
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body.memo, "Corrected");
  });
});
