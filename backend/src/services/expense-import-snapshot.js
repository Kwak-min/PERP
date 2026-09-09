import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseExpenseCsv, validateExpenseCsvMapping, EXPENSE_CSV_DEFAULT_PROVIDER_SOURCE } from './expense-csv.service.js';
import { expenseInput, legacyMinor } from './expense-input.service.js';
import { receiptTokensSchema } from './receipt-files.service.js';
import { cents, decimal } from './pg-finance.service.js';
import { ApiError } from '../utils/errors.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
const ordinal = z.number().int().min(1).max(10000);
const uniqueOrdinals = z.array(ordinal).max(10000).refine(values => new Set(values).size === values.length);
export const previewSchema = z.object({
  upload_id: z.string().uuid(), replaces_job_id: z.string().uuid().optional(),
  provider_source: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).default(EXPENSE_CSV_DEFAULT_PROVIDER_SOURCE),
  mapping: z.array(z.object({ sourceOrdinal: z.number().int().min(1).max(20), target: z.string().nullable() }).strict()).max(20).optional(),
  account_mapping: z.array(z.object({ account_code: z.string().trim().min(1).max(4096), account_id: z.string().min(1).max(100) }).strict()).max(10000).default([]),
  mapping_confirmed: z.boolean().default(false),
  excluded_ordinals: uniqueOrdinals.default([]), duplicate_ordinals: uniqueOrdinals.default([]),
  receipts: z.array(z.object({ logicalRecordOrdinal: ordinal, receipt_tokens: receiptTokensSchema }).strict()).max(10000).default([]),
  no_receipt_reason: z.string().trim().min(1).max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  for (const [items, key] of [[value.account_mapping, 'account_code'], [value.receipts, 'logicalRecordOrdinal']]) {
    if (new Set(items.map(item => item[key])).size !== items.length) ctx.addIssue({ code: 'custom', message: '중복 매핑입니다.' });
  }
  if (value.excluded_ordinals.some(n => value.duplicate_ordinals.includes(n))) ctx.addIssue({ code: 'custom', message: '제외와 중복 확인을 동시에 선택할 수 없습니다.' });
  const tokens = value.receipts.flatMap(row => row.receipt_tokens);
  if (new Set(tokens).size !== tokens.length) ctx.addIssue({ code: 'custom', message: '영수증 token은 한 행에만 사용할 수 있습니다.' });
});

export function makeSnapshot(raw, input, accounts, source) {
  const parsed = parseExpenseCsv(raw);
  const mapping = input.mapping ?? parsed.headers.map(h => ({ sourceOrdinal: h.sourceOrdinal, target: h.suggestedTarget }));
  const active = new Set(accounts.map(account => String(account.id)));
  const references = new Map(input.account_mapping.map(item => [item.account_code, item.account_id]));
  const validated = validateExpenseCsvMapping(parsed, mapping, {
    accountMappingConfirmed: input.mapping_confirmed,
    activeAccountCodes: input.account_mapping.filter(item => active.has(item.account_id)).map(item => item.account_code),
  });
  const ordinals = [...input.excluded_ordinals, ...input.duplicate_ordinals, ...input.receipts.map(row => row.logicalRecordOrdinal)];
  if (ordinals.some(n => n > parsed.logicalRecordCount)) throw new ApiError('VALIDATION_ERROR', '원본 논리 행 번호가 범위를 벗어났습니다.');
  const receipts = new Map(input.receipts.map(row => [row.logicalRecordOrdinal, row.receipt_tokens]));
  const rows = validated.rows.map(row => {
    const excluded = input.excluded_ordinals.includes(row.logicalRecordOrdinal);
    const identity = row.identity.kind === 'external_id'
      ? ['external_id', input.provider_source, row.identity.externalId]
      : ['raw_record', parsed.rawSha256, row.logicalRecordOrdinal];
    const result = { ...row, identity, identity_key: digest(JSON.stringify(identity)), payload: null, payload_sha256: null,
      disposition: excluded ? 'excluded' : 'create', duplicate_confirmed: input.duplicate_ordinals.includes(row.logicalRecordOrdinal), existing_id: null };
    if (row.values) {
      try {
        result.payload = expenseInput({ amount: row.values.amount, currency: row.values.currency,
          expense_date: row.values.expenseDate, merchant: row.values.merchant, account_id: references.get(row.values.accountCode),
          memo: row.values.memo, receipt_tokens: receipts.get(row.logicalRecordOrdinal) ?? [], no_receipt_reason: input.no_receipt_reason });
        // CSV의 의미 있는 사용처 공백은 파서 계약대로 보존한다. strict 경계의 길이/비어 있음 검증은 위에서 수행했다.
        result.payload.counterparty = row.values.merchant;
        if (source === 'legacy') legacyMinor(result.payload.amount);
        result.payload_sha256 = digest(JSON.stringify(result.payload));
      } catch (error) {
        if (error.name !== 'ZodError' && !(error instanceof ApiError)) throw error;
        result.valid = false; result.payload = null; result.payload_sha256 = null;
        result.issues.push({ code: 'INVALID_EXPENSE_INPUT', scope: 'row', logicalRecordOrdinal: row.logicalRecordOrdinal });
      }
    }
    return result;
  });
  return { source, raw_sha256: parsed.rawSha256, parser_version: parsed.parserVersion, provider_source: input.provider_source,
    headers: parsed.headers, mapping, account_mapping: input.account_mapping, mapping_confirmed: input.mapping_confirmed,
    excluded_ordinals: input.excluded_ordinals, duplicate_ordinals: input.duplicate_ordinals,
    no_receipt_reason: input.no_receipt_reason ?? null, issues: validated.issues, rows };
}

export function markIdentities(snapshot, identities) {
  const byKey = new Map(identities.map(identity => [identity.identity_key, identity]));
  for (const row of snapshot.rows) {
    if (row.disposition === 'excluded' || !row.payload) continue;
    const existing = byKey.get(row.identity_key);
    if (existing) {
      if (existing.identity_value !== JSON.stringify(row.identity) || existing.payload_sha256 !== row.payload_sha256) {
        row.valid = false; row.issues.push({ code: 'IDENTITY_PAYLOAD_CONFLICT', scope: 'row', logicalRecordOrdinal: row.logicalRecordOrdinal });
      } else {
        row.existing_id = String(existing.transaction_id);
        if (row.duplicate_confirmed) row.disposition = 'reuse';
        else { row.valid = false; row.issues.push({ code: 'DUPLICATE_CONFIRMATION_REQUIRED', scope: 'row', logicalRecordOrdinal: row.logicalRecordOrdinal }); }
      }
    } else if (row.duplicate_confirmed) {
      row.valid = false; row.issues.push({ code: 'DUPLICATE_NOT_FOUND', scope: 'row', logicalRecordOrdinal: row.logicalRecordOrdinal });
    }
  }
  return snapshot;
}

export function snapshotState(snapshot) {
  return !snapshot.issues.length && snapshot.rows.every(row => row.disposition === 'excluded' || row.valid) ? 'ready' : 'invalid';
}
export function summary(rows, completed = false) {
  const selected = rows.filter(row => row.disposition !== 'excluded');
  return { total: rows.length, selected: selected.length, excluded: rows.length - selected.length,
    errors: selected.filter(row => !row.valid).length,
    duplicates: selected.filter(row => row.existing_id !== null).length,
    ...(completed ? { created: selected.filter(row => row.disposition === 'create').length, reused: selected.filter(row => row.disposition === 'reuse').length } : {}),
    amount: decimal(selected.reduce((sum, row) => sum + (row.payload ? cents(row.payload.amount) : 0n), 0n)) };
}
// Immutable retention allowlist: no source cells, mapping labels, reasons, tokens or writer payload copies.
export function auditSnapshot(snapshot) {
  const { amount, ...counts } = summary(snapshot.rows);
  return { content_expired: true, raw_sha256: snapshot.raw_sha256, parser_version: snapshot.parser_version, counts,
    account_references: snapshot.rows.filter(row => row.disposition !== 'excluded' && row.payload)
      .map(row => ({ logicalRecordOrdinal: row.logicalRecordOrdinal, account_id: row.payload.account_id })) };
}
const expired = job => new ApiError('IMPORT_CONTENT_EXPIRED', '미리보기가 만료되었습니다. 원본을 다시 업로드하세요.', { job_id: job.id }, 410);
export function jobView(job) {
  if (job.snapshot.content_expired) return { job_id: job.id, upload_id: job.upload_id, source: job.source, state: job.state,
    created_at: job.created_at, content_expired: true, raw_sha256: job.snapshot.raw_sha256,
    parser_version: job.snapshot.parser_version, summary: job.result?.summary ?? job.snapshot.counts };
  return { job_id: job.id, upload_id: job.upload_id, source: job.source, state: job.state, content_expired: false,
    created_at: job.created_at, raw_sha256: job.snapshot.raw_sha256, parser_version: job.snapshot.parser_version,
    provider_source: job.snapshot.provider_source, headers: job.snapshot.headers, mapping: job.snapshot.mapping,
    account_mapping: job.snapshot.account_mapping, mapping_confirmed: job.snapshot.mapping_confirmed,
    excluded_ordinals: job.snapshot.excluded_ordinals, duplicate_ordinals: job.snapshot.duplicate_ordinals,
    no_receipt_reason: job.snapshot.no_receipt_reason, issues: job.snapshot.issues,
    summary: job.result?.summary ?? summary(job.snapshot.rows) };
}
const pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25), filter: z.enum(['all','errors','duplicates']).default('all') }).strict();
export function rowPage(job, query) {
  const { offset, limit, filter } = pageSchema.parse(query);
  if (job.snapshot.content_expired) {
    if (job.state !== 'completed') throw expired(job);
    const results = job.result_rows.filter(row => filter === 'all' || (filter === 'duplicates' && row.disposition === 'reuse'));
    return { job_id: job.id, state: job.state, content_expired: true, offset, limit, total: results.length,
      items: results.slice(offset, offset + limit) };
  }
  const rows = job.snapshot.rows.filter(row => filter === 'all' || (filter === 'errors' ? row.issues.length > 0 : row.existing_id !== null));
  return { job_id: job.id, state: job.state, offset, limit, total: rows.length,
    items: rows.slice(offset, offset + limit).map(row => ({ logicalRecordOrdinal: row.logicalRecordOrdinal,
      values: row.values, valid: row.valid, issues: row.issues, warnings: row.warnings, disposition: row.disposition,
      duplicate_confirmed: row.duplicate_confirmed, existing_id: row.existing_id,
      result: job.result_rows?.find(result => result.logicalRecordOrdinal === row.logicalRecordOrdinal)?.result ?? null })) };
}
export function assertReady(job, key) {
  if (job.state === 'completed') {
    if (job.request_key !== key) throw new ApiError('IDEMPOTENCY_CONFLICT', '완료한 job은 원래 요청 키로만 재생할 수 있습니다.');
  } else if (job.snapshot.content_expired) throw expired(job);
  else if (job.state !== 'ready') throw new ApiError('CONFLICT', '새 미리보기에서 매핑과 모든 선택 행을 확인하세요.', { job_id: job.id });
}
export function assertIdentity(row, existing, jobId) {
  if (row.disposition === 'create' ? Boolean(existing) : !existing || String(existing.transaction_id) !== row.existing_id || existing.payload_sha256 !== row.payload_sha256 || existing.identity_value !== JSON.stringify(row.identity)) {
    throw new ApiError('CONFLICT', '미리보기 이후 중복 상태가 변경되었습니다. 새 미리보기를 만드세요.', { reason: 'IMPORT_IDENTITY_CHANGED', job_id: jobId, logicalRecordOrdinal: row.logicalRecordOrdinal });
  }
}
export function importResult(job) {
  return { job_id: job.id, state: 'completed', summary: summary(job.snapshot.rows, true) };
}
export function importAudit(job, results) {
  return { raw_sha256: job.snapshot.raw_sha256, parser_version: job.snapshot.parser_version,
    row_ids: results.filter(row => row.result).map(row => ({ logicalRecordOrdinal: row.logicalRecordOrdinal, id: row.result.id })),
    counts: { total: job.snapshot.rows.length, created: results.filter(row => row.disposition === 'create').length,
      reused: results.filter(row => row.disposition === 'reuse').length, excluded: results.filter(row => row.disposition === 'excluded').length } };
}
