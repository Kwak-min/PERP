export const EXPENSE_CSV_PARSER_VERSION = 'expense-csv-v1:csv-parse@6.1.0';
export const EXPENSE_CSV_DEFAULT_PROVIDER_SOURCE = 'manual_csv';
export const EXPENSE_CSV_LIMITS = Object.freeze({
  rawBytes: 5 * 1024 * 1024,
  logicalDataRecords: 10_000,
  columns: 20,
  cellBytes: 4 * 1024,
});
export const EXPENSE_CSV_TARGETS = Object.freeze([
  'external_id', 'expense_date', 'merchant', 'amount', 'currency', 'account_code', 'memo',
]);
export const EXPENSE_CSV_HEADER_ALIASES = Object.freeze({
  external_id: Object.freeze(['external_id', '거래ID', '외부ID']),
  expense_date: Object.freeze(['expense_date', '일자', '날짜', '사용일']),
  merchant: Object.freeze(['merchant', '사용처', '가맹점']),
  amount: Object.freeze(['amount', '금액', '지출금액']),
  currency: Object.freeze(['currency', '통화']),
  account_code: Object.freeze(['account_code', '계정코드', '계정']),
  memo: Object.freeze(['memo', '내용', '메모']),
});

const oversizedCodes = new Set([
  'CSV_FILE_TOO_LARGE', 'CSV_TOO_MANY_RECORDS', 'CSV_TOO_MANY_COLUMNS', 'CSV_CELL_TOO_LARGE',
]);

export class ExpenseCsvError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExpenseCsvError';
    this.code = code;
    this.status = oversizedCodes.has(code) ? 413 : 400;
    this.details = details;
  }
}
