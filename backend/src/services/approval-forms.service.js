import { ApiError } from '../utils/errors.js';

export const BUILTIN_APPROVAL_FORMS = Object.freeze([
  Object.freeze({ key: 'generic', name: '일반 요청', revision: 1, builtin: true,
    fields: Object.freeze([{ key: 'purpose', label: '목적', type: 'text', required: true }]) }),
  Object.freeze({ key: 'expense_review', name: '지출 검토', revision: 1, builtin: true,
    fields: Object.freeze([{ key: 'purpose', label: '목적', type: 'text', required: true }, { key: 'amount_krw', label: '금액', type: 'krw', required: true }]) }),
  Object.freeze({ key: 'purchase_request', name: '구매 요청', revision: 1, builtin: true,
    fields: Object.freeze([{ key: 'purpose', label: '목적', type: 'text', required: true }, { key: 'amount_krw', label: '금액', type: 'krw', required: true }]) }),
]);

const exactKrw = /^(?:0|[1-9]\d{0,15})\.\d{2}$/;

export function initialApprovalFormRevision(key) {
  return (BUILTIN_APPROVAL_FORMS.find(form => form.key === key)?.revision ?? 0) + 1;
}

// Workflow provenance, not an empty-object heuristic: immediate writers own payload.
export function approvalBody(row, dedicatedBody = row.body) {
  return row.workflow_locked || row.status === 'draft' ? dedicatedBody : row.payload;
}

export function legacyApprovalAmount(body, fallback) {
  if (body.amount_krw === undefined || body.amount_krw === null || body.amount_krw === '') return fallback;
  const value = body.amount_krw;
  if (typeof value !== 'string' || !exactKrw.test(value)) throw new ApiError('VALIDATION_ERROR', '금액은 정확한 KRW 문자열이어야 합니다.');
  const minor = BigInt(value.replace('.', ''));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError('VALIDATION_ERROR', '금액이 안전한 양수 minor 범위를 벗어났습니다.');
  return Number(minor);
}

export function normalizeApprovalFields(fields) {
  if (!Array.isArray(fields)) throw new ApiError('VALIDATION_ERROR', '양식 필드가 올바르지 않습니다.');
  return fields.map((field, index) => {
    const key = String(field.key ?? field.name ?? '').trim();
    const type = String(field.type ?? 'text');
    if (!key || !['text', 'textarea', 'krw'].includes(type)) throw new ApiError('VALIDATION_ERROR', `양식 필드 ${index + 1}이 올바르지 않습니다.`);
    return { key, label: String(field.label ?? key), type, required: Boolean(field.required) };
  });
}

export function validateApprovalSubmission({ title, body, form }) {
  if (!String(title ?? '').trim()) throw new ApiError('VALIDATION_ERROR', '제목은 필수입니다.');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('VALIDATION_ERROR', '결재 본문이 올바르지 않습니다.');
  const fields = normalizeApprovalFields(form.fields);
  for (const field of fields) {
    const value = body[field.key];
    if (field.required && (value === undefined || value === null || (typeof value === 'string' && !value.trim()))) {
      throw new ApiError('VALIDATION_ERROR', `${field.label}은(는) 필수입니다.`, { field: field.key });
    }
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw new ApiError('VALIDATION_ERROR', `${field.label} 값은 문자열이어야 합니다.`, { field: field.key });
    if (field.type === 'krw' && (!exactKrw.test(value) || BigInt(value.replace('.', '')) <= 0n)) {
      throw new ApiError('VALIDATION_ERROR', `${field.label}은 양수인 정확한 KRW 소수 둘째 자리 문자열이어야 합니다.`, { field: field.key });
    }
  }
  return { key: form.key, name: form.name, revision: form.revision, fields };
}
