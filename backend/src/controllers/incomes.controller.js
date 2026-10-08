import { incomeInput, incomeView } from '../services/income-input.service.js';
import { withLegacyFinanceTransaction, replayLegacyMutation, writeLegacyTransaction } from '../services/legacy-expenses.service.js';
import { pgExpenseMutation, postPgTransaction } from '../services/pg-expenses.service.js';

export function createLegacyIncome(req, res) {
  const payload = incomeInput(req.body);
  const result = withLegacyFinanceTransaction(req, principal => {
    principal.require('transaction.confirm');
    return replayLegacyMutation(req, principal, { operation: 'income.create', payload }, () => incomeView(writeLegacyTransaction(principal, payload, req.requestId), payload));
  });
  res.status(201).json(result);
}

export async function createPgIncome(req, res) {
  const payload = incomeInput(req.body);
  const result = await pgExpenseMutation(req, 'income.create', payload, async client => incomeView(await postPgTransaction(client, req, payload), payload));
  res.status(201).json(result);
}
