import { z } from 'zod';
import { expenseInput } from '../services/expense-input.service.js';
import { receiptTokensSchema } from '../services/receipt-files.service.js';
import { pgExpenseMutation, postPgTransaction, appendPgExpenseReceipts } from '../services/pg-expenses.service.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { pgQuery } from '../config/pg.js';
import { notFound } from '../utils/errors.js';

export async function createExpense(req, res) {
  const payload = expenseInput(req.body);
  const result = await pgExpenseMutation(req, 'expense.create', payload, client => postPgTransaction(client, req, payload));
  res.status(201).json(result);
}

export async function appendReceipts(req, res) {
  const body = z.object({ expected_version: z.string().regex(/^\d+$/), receipt_tokens: receiptTokensSchema.refine(tokens => tokens.length > 0) }).strict().parse(req.body);
  const payload = { parentId: req.params.id, expectedVersion: body.expected_version, tokens: body.receipt_tokens };
  const result = await pgExpenseMutation(req, 'transaction.receipts.append', payload, (client, principal) => appendPgExpenseReceipts(client, principal, payload));
  res.json(result);
}

export async function transactionDetail(req, res) {
  const { companyId } = pgIdentity(req);
  if (!/^[1-9]\d*$/.test(req.params.id)) throw notFound('transaction');
  const { rows: [entry] } = await pgQuery(`SELECT e.*,e.xmin::text AS receipt_version,to_char(e.entry_date,'YYYY-MM-DD') AS expense_date,
    (SELECT SUM(CASE WHEN a.account_type='expense' THEN l.debit-l.credit WHEN a.account_type='revenue' THEN l.credit-l.debit ELSE 0 END)::text
      FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id WHERE l.entry_id=e.id) AS amount
    FROM accounting.journal_entries e WHERE e.id=$1 AND e.company_id=$2`, [req.params.id, companyId]);
  if (!entry) throw notFound('transaction');
  const { rows: lines } = await pgQuery(`SELECT l.id::text,l.account_id::text,a.account_type,l.debit::text,l.credit::text
    FROM accounting.journal_lines l JOIN accounting.accounts a ON a.id=l.account_id
    WHERE l.entry_id=$1 AND a.company_id=$2 ORDER BY l.id`, [entry.id, companyId]);
  const accountIds = [...new Set(lines.filter(line => ['expense', 'revenue'].includes(line.account_type)).map(line => line.account_id))];
  const { rows: receipts } = await pgQuery(`SELECT f.id AS file_id,f.original_name AS filename,f.mime_type AS mime,f.size_bytes::int,f.checksum_sha256
    FROM accounting.journal_entry_files l JOIN files.objects f ON f.id=l.file_id AND f.company_id=l.company_id WHERE l.entry_id=$1 AND l.company_id=$2 ORDER BY f.id`, [entry.id, companyId]);
  // Historical multi-account journals have no single selected account; retain their actual lines.
  res.json({ ...entry, id: String(entry.id), status: entry.posted ? 'confirmed' : 'pending',
    account_id: accountIds.length === 1 ? accountIds[0] : null, lines, receipts });
}
