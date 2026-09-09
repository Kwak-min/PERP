import { z } from 'zod';
import { isPgWorkspace } from '../../services/workspace';

export const financePath = (orgId: string | null) => isPgWorkspace(orgId) ? '/pg/finance' : '/finance';
export const receiptSchema = z.object({ file_id: z.coerce.string(), filename: z.string(), mime: z.string(), size_bytes: z.number(), checksum_sha256: z.string().nullable() });
export const uploadSchema = z.object({ token: z.string(), filename: z.string(), mime: z.string(), size_bytes: z.number(), checksum_sha256: z.string(), expires_at: z.string() });
export type Receipt = z.infer<typeof receiptSchema>;
export type Upload = z.infer<typeof uploadSchema>;
export type UploadSlot = Readonly<{ id: string; file: File; state: 'pending' | 'ready' | 'failed'; upload?: Upload; error?: string }>;
const metadata = { counterparty: z.string().nullable(), occurred_at: z.string().nullable(), input_currency: z.string().nullable(), no_receipt_reason: z.string().nullable() };
export const detailSchema = z.object({ id: z.coerce.string(), status: z.string(), amount: z.string().nullable(), expense_date: z.string(), memo: z.string().nullable(),
  account_id: z.coerce.string().nullable(), budget_id: z.coerce.string().nullable(), version: z.number(), receipt_version: z.string().optional(), currency: z.string().optional(),
  ...metadata, receipts: z.array(receiptSchema), lines: z.array(z.object({ id: z.string(), account_id: z.string(), account_type: z.string(), debit: z.string(), credit: z.string() })).optional(),
});
export type Detail = z.infer<typeof detailSchema>;
const legacyRow = z.object({ id: z.string(), kind: z.string(), status: z.string(), expense_date: z.string(), memo: z.string(), amount: z.string(), currency: z.string(), ...metadata });
const pgRow = z.object({ __id: z.coerce.string(), status: z.string(), 일자: z.string(), 내용: z.string().nullable(), 차변: z.string(), 대변: z.string(), ...metadata });
export type LedgerRow = Readonly<{ id: string; status: string; date: string; memo: string; amount: string; credit: string | null; kind: string; currency: string; merchant: string | null; legacy: boolean }>;
export function ledgerRows(payload: unknown, pg: boolean): LedgerRow[] {
  if (pg) return z.object({ items: z.array(pgRow) }).parse(payload).items.map(row => ({ id: row.__id, status: row.status, date: row.일자.slice(0, 10), memo: row.내용 ?? '', amount: row.차변, credit: row.대변, kind: '전표', currency: row.input_currency ?? '', merchant: row.counterparty, legacy: row.input_currency === null }));
  return z.object({ items: z.array(legacyRow) }).parse(payload).items.map(row => ({ id: row.id, status: row.status, date: row.expense_date, memo: row.memo, amount: row.amount, credit: null, kind: row.kind === 'income' ? '수입' : '지출', currency: row.currency, merchant: row.counterparty, legacy: row.input_currency === null }));
}
export type Account = Readonly<{ id: string; label: string }>;
export function expenseAccounts(payload: unknown, pg: boolean): Account[] {
  if (pg) return z.object({ items: z.array(z.object({ value: z.string(), label: z.string(), account_type: z.string() })) }).parse(payload).items.filter(row => row.account_type === 'expense').map(row => ({ id: row.value, label: row.label }));
  return z.object({ items: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() })) }).parse(payload).items.filter(row => row.kind === 'expense').map(row => ({ id: row.id, label: `${row.code} ${row.name}` }));
}
export function budgetOptions(payload: unknown, pg: boolean): Account[] {
  if (pg) return z.object({ items: z.array(z.object({ __id: z.coerce.string(), 이름: z.string(), status: z.string() })) }).parse(payload).items.filter(row => row.status === 'active').map(row => ({ id: row.__id, label: row.이름 }));
  return z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(payload).items.map(row => ({ id: row.id, label: row.name }));
}
export const expenseSchema = z.object({
  amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/, '금액은 소수점 두 자리 이내의 양수로 입력하세요.').refine(value => /[1-9]/.test(value), '금액은 0보다 커야 합니다.'),
  currency: z.literal('KRW'), expense_date: z.string().date('실제 사용일을 입력하세요.').refine(value => !value.startsWith('0000'), '실제 사용일을 입력하세요.'),
  expense_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, '시각을 확인하세요.').optional(),
  merchant: z.string().trim().min(1, '사용처를 입력하세요.').max(200), account_id: z.string().min(1, '지출 계정을 선택하세요.'), budget_id: z.string().nullable(),
  memo: z.string().max(4000), receipt_tokens: z.array(z.string()).max(5), no_receipt_reason: z.string().trim().max(1000).transform(value => value || null),
}).refine(value => value.receipt_tokens.length > 0 || Boolean(value.no_receipt_reason), '영수증 또는 미첨부 사유가 필요합니다.');
export const statusLabel = (status: string) => ({ confirmed: '확정', pending: '미게시', draft: '초안' })[status] ?? status;
