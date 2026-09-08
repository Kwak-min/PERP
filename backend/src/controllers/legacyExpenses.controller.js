import { z } from 'zod';
import { db } from '../config/db.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { expenseInput } from '../services/expense-input.service.js';
import { receiptTokensSchema } from '../services/receipt-files.service.js';
import { legacyReceiptParent } from '../services/legacy-receipt-files.service.js';
import { withLegacyFinanceTransaction, replayLegacyMutation, writeLegacyTransaction, appendLegacyExpenseReceipts, txView } from '../services/legacy-expenses.service.js';

export function createExpense(req, res) {
  const payload = expenseInput(req.body);
  const result = withLegacyFinanceTransaction(req, principal => {
    principal.require('transaction.confirm');
    return replayLegacyMutation(req, principal, { operation: 'expense.create', payload }, () => writeLegacyTransaction(principal, payload, req.requestId));
  });
  res.status(201).json(result);
}

export function appendReceipts(req, res) {
  const body = z.object({ expected_version: z.number().int().positive().safe(), receipt_tokens: receiptTokensSchema.refine(tokens => tokens.length > 0) }).strict().parse(req.body);
  const payload = { parentId: req.params.id, expectedVersion: body.expected_version, tokens: body.receipt_tokens };
  const result = withLegacyFinanceTransaction(req, principal => {
    // 응답 재생도 현재 부모의 행 범위를 다시 확인한다.
    legacyReceiptParent(principal, { kind: 'transaction', parentId: payload.parentId, write: true });
    return replayLegacyMutation(req, principal, { operation: 'transaction.receipts.append', payload }, () => appendLegacyExpenseReceipts(principal, payload));
  });
  res.json(result);
}

export function transactionDetail(req, res) {
  const principal = resolvePrincipal(req);
  const parent = legacyReceiptParent(principal, { kind: 'transaction', parentId: req.params.id });
  const receipts = db().prepare(`SELECT f.id AS file_id,f.filename,f.mime,f.size AS size_bytes,f.checksum AS checksum_sha256 FROM transaction_evidence l
    JOIN file_object f ON f.id=l.file_id AND f.tenant_id=l.tenant_id AND f.org_id=l.org_id
    WHERE l.transaction_id=? AND l.tenant_id=? AND l.org_id=? AND f.deleted_at IS NULL ORDER BY f.id`).all(parent.id, principal.tenantId, principal.orgId);
  res.json({ ...txView(parent), evidence_count: receipts.length, receipts });
}
