import { z } from 'zod';
import { money } from './pg-finance.service.js';

export const incomeSchema = z.object({
  amount: z.string().transform(money),
  currency: z.literal('KRW').default('KRW'),
  income_date: z.string().date().refine(value => !value.startsWith('0000-')),
  payer: z.string().trim().min(1).max(200),
  account_id: z.string().min(1).max(100),
  project_id: z.string().min(1).max(100).nullable().optional(),
  memo: z.string().max(4000).default(''),
}).strict();

export function incomeInput(body) {
  const value = incomeSchema.parse(body);
  return { kind: 'income', amount: value.amount, input_currency: value.currency,
    entry_date: value.income_date, counterparty: value.payer, account_id: value.account_id, memo: value.memo,
    ...(value.project_id ? { project_id: value.project_id } : {}) };
}

export function incomeView(result, payload) {
  return { ...result, kind: 'income', income_date: payload.entry_date, payer: payload.counterparty };
}
