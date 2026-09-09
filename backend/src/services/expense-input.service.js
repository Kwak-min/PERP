import { z } from 'zod';
import { cents, money } from './pg-finance.service.js';
import { receiptTokensSchema } from './receipt-files.service.js';
import { ApiError } from '../utils/errors.js';

export const requestKeySchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);
export const expenseSchema = z.object({
  amount: z.string().transform(money),
  currency: z.literal('KRW').default('KRW'),
  expense_date: z.string().date().refine(value => !value.startsWith('0000-')),
  expense_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).optional(),
  merchant: z.string().trim().min(1).max(200),
  account_id: z.string().min(1).max(100),
  budget_id: z.string().min(1).max(100).nullable().optional(),
  memo: z.string().max(4000).default(''),
  receipt_tokens: receiptTokensSchema.default([]),
  no_receipt_reason: z.string().trim().min(1).max(1000).nullable().optional(),
}).strict().refine(value => value.receipt_tokens.length > 0 || Boolean(value.no_receipt_reason), '영수증 또는 미첨부 사유가 필요합니다.');

export function expenseInput(body) {
  const value = expenseSchema.parse(body);
  return {
    kind: 'expense', amount: value.amount, entry_date: value.expense_date,
    counterparty: value.merchant, occurred_at: value.expense_time ? new Date(`${value.expense_date}T${value.expense_time}${value.expense_time.length === 5 ? ':00' : ''}+09:00`).toISOString() : null,
    input_currency: value.currency, no_receipt_reason: value.no_receipt_reason ?? null,
    account_id: value.account_id, budget_id: value.budget_id ?? null,
    memo: value.memo, receipt_tokens: value.receipt_tokens,
  };
}

export function legacyMinor(amount) {
  const minor = cents(amount);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError('VALIDATION_ERROR', '기존 장부의 안전한 최소 화폐 단위 범위를 초과했습니다.');
  return Number(minor);
}
