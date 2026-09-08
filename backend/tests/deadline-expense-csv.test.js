import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

let csvService;
let serviceImportError;
try {
  csvService = await import('../src/services/expense-csv.service.js');
} catch (error) {
  serviceImportError = error;
}

function service() {
  assert.ifError(serviceImportError);
  assert.equal(typeof csvService?.parseExpenseCsv, 'function', 'expense CSV parser must be exported');
  assert.equal(typeof csvService?.validateExpenseCsvMapping, 'function', 'expense CSV mapping validator must be exported');
  return csvService;
}

function buffer(text) {
  return Buffer.from(text, 'utf8');
}

function suggestedMapping(parsed) {
  return parsed.headers.map(({ sourceOrdinal, suggestedTarget }) => ({ sourceOrdinal, target: suggestedTarget }));
}

function validateReady(parsed, context = {}) {
  return service().validateExpenseCsvMapping(parsed, suggestedMapping(parsed), {
    accountMappingConfirmed: true,
    activeAccountCodes: ['6000'],
    ...context,
  });
}

function assertCsvError(expectedCode) {
  return (error) => {
    assert.equal(error?.name, 'ExpenseCsvError');
    assert.equal(error?.code, expectedCode);
    assert.equal(typeof error?.message, 'string');
    assert.equal(error?.status, ['CSV_FILE_TOO_LARGE', 'CSV_TOO_MANY_RECORDS', 'CSV_TOO_MANY_COLUMNS', 'CSV_CELL_TOO_LARGE'].includes(expectedCode) ? 413 : 400);
    return true;
  };
}

test('loads the exact csv-parse 7.0.2 MIT dependency used by the service', async () => {
  // Given
  const packageUrl = new URL('../package.json', import.meta.resolve('csv-parse/sync'));

  // When
  const dependency = JSON.parse(await readFile(packageUrl, 'utf8'));

  // Then
  assert.equal(dependency.version, '7.0.2');
  assert.equal(dependency.license, 'MIT');
  assert.equal(service().EXPENSE_CSV_PARSER_VERSION, 'expense-csv-v1:csv-parse@7.0.2');
  assert.equal(service().EXPENSE_CSV_DEFAULT_PROVIDER_SOURCE, 'manual_csv');
});

test('keeps duplicated prototype columns as own data without replacing the record prototype', async () => {
  const { parse } = await import('csv-parse/sync');
  const raw = buffer('__proto__,__proto__,constructor\nfirst,second,plain');
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);

  const [record] = parse(raw, { columns: true, group_columns_by_name: true });

  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(record, '__proto__'), {
    value: ['first', 'second'], writable: true, enumerable: true, configurable: true,
  });
  assert.equal(Object.hasOwn(record, 'constructor'), true);
  assert.equal(record.constructor, 'plain');
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeDescriptors);
  assert.throws(() => service().parseExpenseCsv(raw), assertCsvError('CSV_DUPLICATE_HEADER'));
});

test('parses a representative BOM/RFC4180 file without changing meaningful whitespace or exact money', async () => {
  // Given
  const raw = await readFile(new URL('./fixtures/expense-rfc4180.csv', import.meta.url));

  // When
  const parsed = service().parseExpenseCsv(raw);
  const preview = validateReady(parsed);

  // Then
  assert.equal(parsed.kind, 'expense_csv_parse');
  assert.equal(preview.kind, 'expense_csv_validation');
  assert.equal(parsed.rawSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(parsed.logicalRecordCount, 2);
  assert.equal(parsed.headers[0].name, '거래ID');
  assert.deepEqual(parsed.mappingIssues, []);
  assert.deepEqual(parsed.headers.at(-1), {
    sourceOrdinal: 8,
    name: '추가열',
    normalizedName: '추가열',
    suggestedTarget: null,
    disposition: 'ignored',
  });
  assert.equal(preview.ready, true);
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.rows[0].values.amount, '9999999999999999.99');
  assert.equal(preview.rows[0].values.merchant, '  카페, 본점  ');
  assert.equal(preview.rows[0].values.memo, '  팀 "저녁"\r\n두 줄  ');
  assert.deepEqual(preview.rows.map((row) => row.identity), [
    { kind: 'raw_record', rawSha256: parsed.rawSha256, logicalRecordOrdinal: 1 },
    { kind: 'raw_record', rawSha256: parsed.rawSha256, logicalRecordOrdinal: 2 },
  ]);
  assert.deepEqual(preview.rows[0].values, preview.rows[1].values);
  assert.notDeepEqual(preview.rows[0].identity, preview.rows[1].identity);
});

test('suggests every Contract F Korean alias and keeps account confirmation explicit', () => {
  // Given
  const raw = buffer('외부ID,사용일,가맹점,지출금액,통화,계정,내용,모르는열\nX-7,2026-02-28,상점,10.5,KRW,6000, 메모 ,값');

  // When
  const parsed = service().parseExpenseCsv(raw);
  const unconfirmed = service().validateExpenseCsvMapping(parsed, suggestedMapping(parsed), {
    accountMappingConfirmed: false,
    activeAccountCodes: ['6000'],
  });
  const confirmed = validateReady(parsed);

  // Then
  assert.deepEqual(parsed.headers.map((header) => header.suggestedTarget), [
    'external_id', 'expense_date', 'merchant', 'amount', 'currency', 'account_code', 'memo', null,
  ]);
  assert.equal(unconfirmed.ready, false);
  assert.ok(unconfirmed.issues.some((issue) => issue.code === 'ACCOUNT_MAPPING_CONFIRMATION_REQUIRED'));
  assert.equal(confirmed.ready, true);
  assert.deepEqual(confirmed.rows[0].identity, { kind: 'external_id', externalId: 'X-7' });
  assert.deepEqual(confirmed.rows[0].values, {
    externalId: 'X-7',
    expenseDate: '2026-02-28',
    merchant: '상점',
    amount: '10.50',
    currency: 'KRW',
    accountCode: '6000',
    memo: ' 메모 ',
  });
});

test('defaults an absent optional currency column to KRW', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer('날짜,사용처,금액,계정코드\n2024-02-29,식당,1,6000'));

  // When
  const preview = validateReady(parsed);

  // Then
  assert.equal(preview.ready, true);
  assert.equal(preview.rows[0].values.currency, 'KRW');
  assert.equal(preview.rows[0].values.amount, '1.00');
  assert.equal(preview.rows[0].values.memo, '');
});

test('reports ambiguous automatic targets and rejects duplicate target mappings', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer('날짜,일자,사용처,금액,계정코드\n2026-01-01,2026-01-01,상점,1,6000'));

  // When
  const preview = validateReady(parsed);

  // Then
  assert.deepEqual(parsed.mappingIssues.map((issue) => issue.code), ['AMBIGUOUS_TARGET']);
  assert.deepEqual(parsed.headers.slice(0, 2).map((header) => header.disposition), ['ambiguous', 'ambiguous']);
  assert.equal(preview.ready, false);
  assert.ok(preview.issues.some((issue) => issue.code === 'DUPLICATE_TARGET_MAPPING' && issue.target === 'expense_date'));
});

test('rejects duplicate normalized headers before mapping', () => {
  // Given
  const raw = buffer('날짜, 날짜 ,사용처,금액,계정코드\n2026-01-01,2026-01-01,상점,1,6000');

  // When / Then
  assert.throws(() => service().parseExpenseCsv(raw), assertCsvError('CSV_DUPLICATE_HEADER'));
});

test('rejects malformed CSV, invalid UTF-8, ragged records, and interior blank records', () => {
  // Given
  const cases = [
    ['CSV_INVALID_UTF8', Buffer.from([0xff, 0xfe, 0xfd])],
    ['CSV_PARSE_ERROR', buffer('날짜,사용처,금액,계정코드\n2026-01-01,"열린 인용,1,6000')],
    ['CSV_RAGGED_RECORD', buffer('날짜,사용처,금액,계정코드\n2026-01-01,상점,1')],
    ['CSV_RAGGED_RECORD', buffer('날짜,사용처,금액,계정코드\n2026-01-01,상점,1,6000\n\n2026-01-02,상점,2,6000')],
  ];

  // When / Then
  for (const [code, raw] of cases) assert.throws(() => service().parseExpenseCsv(raw), assertCsvError(code));
});

test('enforces raw bytes, logical records, columns, and per-cell limits', () => {
  // Given
  const tooManyRecords = `날짜,사용처,금액,계정코드\n${'2026-01-01,상점,1,6000\n'.repeat(10_001)}`;
  const tooManyColumns = `${Array.from({ length: 21 }, (_, index) => `열${index}`).join(',')}\n${Array(21).fill('값').join(',')}`;
  const oversizedCell = `날짜,사용처,금액,계정코드\n2026-01-01,${'가'.repeat(1366)},1,6000`;

  // When / Then
  assert.throws(() => service().parseExpenseCsv('not bytes'), assertCsvError('CSV_INPUT_TYPE'));
  assert.throws(() => service().parseExpenseCsv(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)), assertCsvError('CSV_FILE_TOO_LARGE'));
  assert.throws(() => service().parseExpenseCsv(buffer(tooManyRecords)), assertCsvError('CSV_TOO_MANY_RECORDS'));
  assert.throws(() => service().parseExpenseCsv(buffer(tooManyColumns)), assertCsvError('CSV_TOO_MANY_COLUMNS'));
  assert.throws(() => service().parseExpenseCsv(buffer(oversizedCell)), assertCsvError('CSV_CELL_TOO_LARGE'));
});

test('accepts exact structural boundaries before rejecting the next byte or record', () => {
  // Given
  const exactRawLimit = buffer(`열,추가\r\n${`${'a'.repeat(4096)},\r\n`.repeat(1278)}${'a'.repeat(4096)},${'b'.repeat(249)}`);
  const exactRecordLimit = buffer(`열\n${'값\n'.repeat(10_000)}`);
  const exactColumnLimit = buffer(`${Array.from({ length: 20 }, (_, index) => `열${index}`).join(',')}\n${Array(20).fill('값').join(',')}`);
  const exactCellLimit = buffer(`열\n${'가'.repeat(1365)}a`);

  // When
  const rawBoundary = service().parseExpenseCsv(exactRawLimit);
  const recordBoundary = service().parseExpenseCsv(exactRecordLimit);
  const columnBoundary = service().parseExpenseCsv(exactColumnLimit);
  const cellBoundary = service().parseExpenseCsv(exactCellLimit);

  // Then
  assert.equal(exactRawLimit.byteLength, 5 * 1024 * 1024);
  assert.equal(rawBoundary.logicalRecordCount, 1279);
  assert.equal(recordBoundary.logicalRecordCount, 10_000);
  assert.equal(columnBoundary.headers.length, 20);
  assert.equal(Buffer.byteLength(cellBoundary.records[0].cells[0], 'utf8'), 4096);
});

test('rejects missing data rows and empty headers with stable parser errors', () => {
  // Given / When / Then
  assert.throws(() => service().parseExpenseCsv(buffer('날짜,사용처,금액,계정코드\n')), assertCsvError('CSV_NO_DATA'));
  assert.throws(() => service().parseExpenseCsv(buffer('날짜,,금액,계정코드\n2026-01-01,상점,1,6000')), assertCsvError('CSV_HEADER_REQUIRED'));
});

test('rejects year zero because PostgreSQL DATE has no year zero', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer('날짜,사용처,금액,계정코드\n0000-01-01,상점,1,6000'));

  // When
  const preview = validateReady(parsed);

  // Then
  assert.equal(preview.ready, false);
  assert.deepEqual(preview.rows[0].issues.map((issue) => issue.code), ['INVALID_DATE']);
  assert.equal(preview.rows[0].values, null);
});

test('accepts year one at the PostgreSQL DATE lower calendar boundary', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer('날짜,사용처,금액,계정코드\n0001-01-01,상점,1,6000'));

  // When
  const preview = validateReady(parsed);

  // Then
  assert.equal(preview.ready, true);
  assert.equal(preview.rows[0].values.expenseDate, '0001-01-01');
});

test('returns typed row issues for impossible dates, exponent money, non-KRW, and inactive accounts', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer([
    '날짜,사용처,금액,통화,계정코드',
    '2026-02-29,상점,1,KRW,6000',
    '2026-02-28,상점,1e3,KRW,6000',
    '2026-02-28,상점,1,USD,6000',
    '2026-02-28,상점,1,KRW,7000',
  ].join('\n')));

  // When
  const preview = validateReady(parsed);

  // Then
  assert.equal(preview.ready, false);
  assert.deepEqual(preview.rows.map((row) => row.issues.map((issue) => issue.code)), [
    ['INVALID_DATE'], ['INVALID_AMOUNT'], ['INVALID_CURRENCY'], ['INACTIVE_ACCOUNT'],
  ]);
  assert.ok(preview.rows.every((row) => row.valid === false && row.values === null));
});

test('requires mandatory mappings and rejects malformed mapping entries', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer('날짜,사용처,금액,계정코드\n2026-01-01,상점,1,6000'));

  // When
  const missing = service().validateExpenseCsvMapping(parsed, [
    { sourceOrdinal: 1, target: 'expense_date' },
    { sourceOrdinal: 2, target: 'merchant' },
    { sourceOrdinal: 4, target: 'account_code' },
  ], { accountMappingConfirmed: true, activeAccountCodes: ['6000'] });

  // Then
  assert.equal(missing.ready, false);
  assert.ok(missing.issues.some((issue) => issue.code === 'MISSING_TARGET_MAPPING' && issue.target === 'amount'));
  assert.throws(
    () => service().validateExpenseCsvMapping(parsed, [{ sourceOrdinal: 99, target: 'amount' }], {}),
    assertCsvError('CSV_MAPPING_INVALID'),
  );
});

test('keeps similar and identical fallback rows while warning instead of deduplicating', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer([
    '날짜,사용처,금액,계정코드',
    '2026-01-01,상점,10,6000',
    '2026-01-01,상점,10,6000',
  ].join('\n')));

  // When
  const preview = validateReady(parsed);

  // Then
  assert.equal(preview.ready, true);
  assert.equal(preview.rows.length, 2);
  assert.ok(preview.rows.every((row) => row.warnings.some((warning) => warning.code === 'POSSIBLE_DUPLICATE')));
  assert.deepEqual(preview.rows.map((row) => row.identity.logicalRecordOrdinal), [1, 2]);
});

test('rejects duplicate non-empty external IDs because they are the same persistent identity', () => {
  // Given
  const parsed = service().parseExpenseCsv(buffer([
    '거래ID,날짜,사용처,금액,계정코드',
    'same,2026-01-01,상점,10,6000',
    'same,2026-01-02,다른상점,20,6000',
  ].join('\n')));

  // When
  const preview = validateReady(parsed);

  // Then
  assert.equal(preview.ready, false);
  assert.ok(preview.rows.every((row) => row.issues.some((issue) => issue.code === 'DUPLICATE_EXTERNAL_ID')));
});
