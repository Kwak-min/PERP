import { z } from 'zod';
import { ApiError } from './api';
import { incomeSchema, expenseSchema } from '../screens/expenses/model';

export type MoneyAttemptScope = Readonly<{ userId: string; source: 'legacy' | 'pg'; orgId: string }>;
export type MoneyAttempt = { kind: 'income'; key: string; body: z.infer<typeof incomeSchema> }
  | { kind: 'expense'; key: string; body: z.infer<typeof expenseSchema> };
const prefix = 'orbitflow.money-attempt.v1:';
const storageKey = (scope: MoneyAttemptScope) => prefix + JSON.stringify([scope.source, scope.userId, scope.orgId]);
const envelope = z.object({ kind: z.enum(['income', 'expense']), key: z.string().uuid(), body: z.record(z.string(), z.unknown()) }).strict();

export function knownMoneyRollback(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
    && ['VALIDATION_ERROR', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONFLICT', 'PERIOD_LOCKED', 'IDEMPOTENCY_CONFLICT', 'MODULE_DISABLED', 'PASSWORD_CHANGE_REQUIRED', 'NO_ORGANIZATION'].includes(error.code);
}

export function loadMoneyAttempt(scope: MoneyAttemptScope): MoneyAttempt | null {
  const raw = sessionStorage.getItem(storageKey(scope));
  if (!raw) return null;
  const stored = envelope.parse(JSON.parse(raw));
  const attempt: MoneyAttempt = stored.kind === 'income'
    ? { kind: 'income', key: stored.key, body: incomeSchema.parse(stored.body) }
    : { kind: 'expense', key: stored.key, body: expenseSchema.parse({ ...stored.body, no_receipt_reason: stored.body.no_receipt_reason ?? '' }) };
  // 복원 중 필드가 유실되거나 재해석되면 새 요청으로 대체하지 않고 입력을 차단한다.
  if (JSON.stringify(attempt.body) !== JSON.stringify(stored.body)) throw new Error('보관된 돈 기록 요청을 그대로 복원할 수 없습니다. 장부와 요청 상태를 확인하세요.');
  return attempt;
}

export function saveMoneyAttempt(scope: MoneyAttemptScope, attempt: MoneyAttempt): void {
  const existing = loadMoneyAttempt(scope);
  if (existing && JSON.stringify(existing) !== JSON.stringify(attempt)) throw new Error('먼저 보관된 돈 기록 요청의 결과를 확인하세요.');
  // 전송 전에 보존한다. 브라우저 저장에 실패하면 네트워크 요청도 보내지 않는다.
  sessionStorage.setItem(storageKey(scope), JSON.stringify(attempt));
}
export function clearMoneyAttempt(scope: MoneyAttemptScope): void {
  sessionStorage.removeItem(storageKey(scope));
}
export function clearMoneyAttempts(): void {
  for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key);
}
