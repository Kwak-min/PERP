import {
  EXPENSE_CSV_PARSER_VERSION,
  EXPENSE_CSV_TARGETS,
  ExpenseCsvError,
} from './expense-csv-contract.js';

const REQUIRED_TARGETS = Object.freeze(['expense_date', 'merchant', 'amount', 'account_code']);
const targetSet = new Set(EXPENSE_CSV_TARGETS);

function mappingIndex(parsed, mapping) {
  if (parsed?.kind !== 'expense_csv_parse' || parsed.parserVersion !== EXPENSE_CSV_PARSER_VERSION || !Array.isArray(parsed.headers) || !Array.isArray(parsed.records) || !Array.isArray(mapping)) {
    throw new ExpenseCsvError('CSV_MAPPING_INVALID', 'Mapping does not match a parsed expense CSV');
  }
  const byTarget = new Map();
  const seenSources = new Set();
  for (const entry of mapping) {
    if (!entry || !Number.isInteger(entry.sourceOrdinal) || entry.sourceOrdinal < 1 || entry.sourceOrdinal > parsed.headers.length || seenSources.has(entry.sourceOrdinal) || (entry.target !== null && !targetSet.has(entry.target))) {
      throw new ExpenseCsvError('CSV_MAPPING_INVALID', 'Mapping contains an invalid or repeated source column');
    }
    seenSources.add(entry.sourceOrdinal);
    if (entry.target === null) continue;
    const ordinals = byTarget.get(entry.target) ?? [];
    ordinals.push(entry.sourceOrdinal);
    byTarget.set(entry.target, ordinals);
  }
  return byTarget;
}

function rowIssue(code, logicalRecordOrdinal, target, message) {
  return { code, scope: 'row', logicalRecordOrdinal, target, message };
}

function exactMoney(value) {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  if (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) <= 0n) return null;
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function isoDate(value) {
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1] ? text : null;
}

function normalizeRow(state, record) {
  const { parsed, sourceByTarget, activeAccounts, hasAccountContext } = state;
  const { logicalRecordOrdinal, cells } = record;
  const at = (target) => sourceByTarget[target] === null ? '' : cells[sourceByTarget[target]];
  const expenseDate = isoDate(at('expense_date'));
  const merchant = at('merchant');
  const amount = exactMoney(at('amount'));
  const currency = at('currency').trim().toUpperCase() || 'KRW';
  const accountCode = at('account_code').trim();
  const externalId = at('external_id').trim();
  const issues = [];
  if (!expenseDate) issues.push(rowIssue('INVALID_DATE', logicalRecordOrdinal, 'expense_date', 'Date must be a real YYYY-MM-DD date'));
  if (merchant.trim().length === 0 || [...merchant].length > 200) issues.push(rowIssue('INVALID_MERCHANT', logicalRecordOrdinal, 'merchant', 'Merchant must contain 1 to 200 characters'));
  if (!amount) issues.push(rowIssue('INVALID_AMOUNT', logicalRecordOrdinal, 'amount', 'Amount must be a positive NUMERIC(18,2) decimal without exponent notation'));
  if (currency !== 'KRW') issues.push(rowIssue('INVALID_CURRENCY', logicalRecordOrdinal, 'currency', 'New expenses must use KRW'));
  if (accountCode.length === 0) issues.push(rowIssue('ACCOUNT_REQUIRED', logicalRecordOrdinal, 'account_code', 'Account code is required'));
  else if (hasAccountContext && !activeAccounts.has(accountCode)) issues.push(rowIssue('INACTIVE_ACCOUNT', logicalRecordOrdinal, 'account_code', 'Account must be active in the selected company'));
  const identity = externalId
    ? { kind: 'external_id', externalId }
    : { kind: 'raw_record', rawSha256: parsed.rawSha256, logicalRecordOrdinal };
  const values = issues.length === 0 ? { externalId, expenseDate, merchant, amount, currency, accountCode, memo: at('memo') } : null;
  return { logicalRecordOrdinal, identity, valid: issues.length === 0, values, issues, warnings: [] };
}

function markDuplicateExternalIds(rows) {
  const externalOrdinals = new Map();
  for (const row of rows) {
    if (row.identity.kind !== 'external_id') continue;
    const ordinals = externalOrdinals.get(row.identity.externalId) ?? [];
    ordinals.push(row.logicalRecordOrdinal);
    externalOrdinals.set(row.identity.externalId, ordinals);
  }
  for (const ordinals of externalOrdinals.values()) {
    if (ordinals.length < 2) continue;
    for (const row of rows.filter((item) => ordinals.includes(item.logicalRecordOrdinal))) {
      row.issues.push(rowIssue('DUPLICATE_EXTERNAL_ID', row.logicalRecordOrdinal, 'external_id', 'An external ID occurs more than once'));
      row.valid = false;
      row.values = null;
    }
  }
}

function markSimilarRows(rows) {
  const signatures = new Map();
  for (const row of rows) {
    if (!row.values) continue;
    const signature = JSON.stringify([row.values.expenseDate, row.values.merchant, row.values.amount]);
    const similar = signatures.get(signature) ?? [];
    similar.push(row);
    signatures.set(signature, similar);
  }
  for (const similar of signatures.values()) {
    if (similar.length < 2) continue;
    for (const row of similar) row.warnings.push({ code: 'POSSIBLE_DUPLICATE', scope: 'row', logicalRecordOrdinal: row.logicalRecordOrdinal, message: 'A similar row is retained for review' });
  }
}

export function validateExpenseCsvMapping(parsed, mapping, context = {}) {
  const byTarget = mappingIndex(parsed, mapping);
  const issues = [];
  for (const [target, sourceOrdinals] of byTarget) {
    if (sourceOrdinals.length > 1) issues.push({ code: 'DUPLICATE_TARGET_MAPPING', scope: 'mapping', target, sourceOrdinals, message: 'A target may be mapped only once' });
  }
  for (const target of REQUIRED_TARGETS) {
    if (!byTarget.has(target)) issues.push({ code: 'MISSING_TARGET_MAPPING', scope: 'mapping', target, message: 'A required target is not mapped' });
  }
  if (context.accountMappingConfirmed !== true) issues.push({ code: 'ACCOUNT_MAPPING_CONFIRMATION_REQUIRED', scope: 'mapping', target: 'account_code', message: 'Account mapping requires explicit confirmation' });
  const hasAccountContext = Array.isArray(context.activeAccountCodes);
  if (!hasAccountContext) issues.push({ code: 'ACCOUNT_REFERENCE_CONTEXT_REQUIRED', scope: 'mapping', target: 'account_code', message: 'Active company accounts are required for validation' });
  const activeAccounts = new Set((context.activeAccountCodes ?? []).map((code) => String(code).trim()));
  const sourceByTarget = Object.fromEntries(EXPENSE_CSV_TARGETS.map((target) => {
    const ordinals = byTarget.get(target);
    return [target, ordinals?.length === 1 ? ordinals[0] - 1 : null];
  }));
  const normalization = { parsed, sourceByTarget, activeAccounts, hasAccountContext };
  const rows = parsed.records.map((record) => normalizeRow(normalization, record));
  markDuplicateExternalIds(rows);
  markSimilarRows(rows);

  return {
    kind: 'expense_csv_validation',
    parserVersion: parsed.parserVersion,
    rawSha256: parsed.rawSha256,
    mapping: Object.fromEntries(EXPENSE_CSV_TARGETS.map((target) => [target, sourceByTarget[target] === null ? null : sourceByTarget[target] + 1])),
    ignoredSourceOrdinals: parsed.headers.map((header) => header.sourceOrdinal).filter((sourceOrdinal) => !mapping.some((entry) => entry.sourceOrdinal === sourceOrdinal && entry.target !== null)),
    ready: issues.length === 0 && rows.every((row) => row.valid),
    issues,
    rows,
  };
}
