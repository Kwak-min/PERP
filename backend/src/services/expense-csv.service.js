import { createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { parse } from 'csv-parse/sync';
import {
  EXPENSE_CSV_HEADER_ALIASES,
  EXPENSE_CSV_LIMITS,
  EXPENSE_CSV_PARSER_VERSION,
  ExpenseCsvError,
} from './expense-csv-contract.js';

export {
  EXPENSE_CSV_DEFAULT_PROVIDER_SOURCE,
  EXPENSE_CSV_HEADER_ALIASES,
  EXPENSE_CSV_LIMITS,
  EXPENSE_CSV_PARSER_VERSION,
  EXPENSE_CSV_TARGETS,
  ExpenseCsvError,
} from './expense-csv-contract.js';
export { validateExpenseCsvMapping } from './expense-csv-validation.js';

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();
const aliasTargets = new Map();
for (const [target, aliases] of Object.entries(EXPENSE_CSV_HEADER_ALIASES)) {
  for (const alias of aliases) aliasTargets.set(normalizeHeader(alias), target);
}

function normalizeHeader(value) {
  return value.normalize('NFC').trim().toLocaleLowerCase('en-US');
}

function parserError(error) {
  if (error && typeof error === 'object' && String(error.code ?? '').includes('RECORD_INCONSISTENT')) {
    return new ExpenseCsvError('CSV_RAGGED_RECORD', 'CSV records must all have the header width', {
      logicalRecordOrdinal: Number.isInteger(error.records) ? error.records : undefined,
    });
  }
  return new ExpenseCsvError('CSV_PARSE_ERROR', 'CSV is not valid RFC4180 data', {
    parserCode: error && typeof error === 'object' ? error.code ?? null : null,
  });
}

function decodeRaw(raw) {
  if (!(raw instanceof Uint8Array)) throw new ExpenseCsvError('CSV_INPUT_TYPE', 'CSV input must be raw bytes');
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.byteLength > EXPENSE_CSV_LIMITS.rawBytes) {
    throw new ExpenseCsvError('CSV_FILE_TOO_LARGE', 'CSV exceeds the 5 MiB raw byte limit', { bytes: bytes.byteLength });
  }
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { bytes, text: textDecoder.decode(bytes.subarray(hasBom ? 3 : 0)) };
  } catch (error) {
    if (error instanceof TypeError) throw new ExpenseCsvError('CSV_INVALID_UTF8', 'CSV must be valid UTF-8');
    throw error;
  }
}

function enforceStructure(records) {
  if (records.length === 0) throw new ExpenseCsvError('CSV_HEADER_REQUIRED', 'CSV header is required');
  const header = records[0];
  if (header.length > EXPENSE_CSV_LIMITS.columns) {
    throw new ExpenseCsvError('CSV_TOO_MANY_COLUMNS', 'CSV exceeds the 20 column limit', { columns: header.length });
  }
  if (records.length === 1) throw new ExpenseCsvError('CSV_NO_DATA', 'CSV requires at least one logical data record');
  if (records.length - 1 > EXPENSE_CSV_LIMITS.logicalDataRecords) {
    throw new ExpenseCsvError('CSV_TOO_MANY_RECORDS', 'CSV exceeds the 10000 logical data record limit', { records: records.length - 1 });
  }
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    if (record.length !== header.length) {
      throw new ExpenseCsvError('CSV_RAGGED_RECORD', 'CSV records must all have the header width', { logicalRecordOrdinal: recordIndex });
    }
    for (let columnIndex = 0; columnIndex < record.length; columnIndex += 1) {
      const size = textEncoder.encode(record[columnIndex]).byteLength;
      if (size > EXPENSE_CSV_LIMITS.cellBytes) {
        throw new ExpenseCsvError('CSV_CELL_TOO_LARGE', 'CSV cell exceeds the 4 KiB UTF-8 limit', {
          logicalRecordOrdinal: recordIndex,
          sourceOrdinal: columnIndex + 1,
          bytes: size,
        });
      }
    }
  }
  return header;
}

function classifyHeaders(header) {
  const normalizedNames = header.map(normalizeHeader);
  const emptyIndex = normalizedNames.findIndex((name) => name.length === 0);
  if (emptyIndex >= 0) throw new ExpenseCsvError('CSV_HEADER_REQUIRED', 'CSV headers cannot be empty', { sourceOrdinal: emptyIndex + 1 });
  const duplicate = normalizedNames.find((name, index) => normalizedNames.indexOf(name) !== index);
  if (duplicate) throw new ExpenseCsvError('CSV_DUPLICATE_HEADER', 'CSV headers must be unique after normalization', { header: duplicate });
  const headers = header.map((name, index) => {
    const normalizedName = normalizedNames[index];
    const suggestedTarget = aliasTargets.get(normalizedName) ?? null;
    return { sourceOrdinal: index + 1, name, normalizedName, suggestedTarget, disposition: suggestedTarget ? 'mapped' : 'ignored' };
  });
  const targetOrdinals = new Map();
  for (const item of headers) {
    if (!item.suggestedTarget) continue;
    const ordinals = targetOrdinals.get(item.suggestedTarget) ?? [];
    ordinals.push(item.sourceOrdinal);
    targetOrdinals.set(item.suggestedTarget, ordinals);
  }
  return {
    headers: headers.map((item) => ({
      ...item,
      disposition: item.suggestedTarget && targetOrdinals.get(item.suggestedTarget).length > 1 ? 'ambiguous' : item.disposition,
    })),
    mappingIssues: [...targetOrdinals]
      .filter(([, ordinals]) => ordinals.length > 1)
      .map(([target, sourceOrdinals]) => ({ code: 'AMBIGUOUS_TARGET', scope: 'mapping', target, sourceOrdinals, message: 'Several headers suggest the same target' })),
  };
}

export function parseExpenseCsv(raw) {
  const { bytes, text } = decodeRaw(raw);
  let records;
  try {
    records = parse(text, {
      bom: false,
      columns: false,
      delimiter: ',',
      escape: '"',
      quote: '"',
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: false,
      trim: false,
    });
  } catch (error) {
    throw parserError(error);
  }
  const header = enforceStructure(records);
  const { headers, mappingIssues } = classifyHeaders(header);
  return {
    kind: 'expense_csv_parse',
    parserVersion: EXPENSE_CSV_PARSER_VERSION,
    rawSha256: createHash('sha256').update(bytes).digest('hex'),
    logicalRecordCount: records.length - 1,
    headers,
    mappingIssues,
    records: records.slice(1).map((cells, index) => ({ logicalRecordOrdinal: index + 1, cells })),
  };
}
