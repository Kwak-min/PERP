import { z } from 'zod';
import { ApiError } from '../utils/errors.js';

const date = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
  const instant = new Date(value + 'T00:00:00Z');
  return value.slice(0, 4) !== '0000' && Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}, '실제 날짜가 필요합니다.');
const filterSchema = z.object({ from: date.optional(), to: date.optional(), tz: z.string().default('Asia/Seoul') }).strict();
export const REPORT_KEYS = ['members', 'tasks', 'transactions', 'budgets', 'approvals_created', 'approvals_decided'];
export const exportInput = z.union([
  z.object({ reportKey: z.enum(REPORT_KEYS), filter: filterSchema.default({}) }).strict(),
  // 기존 소비자도 같은 allowlist/기간 검증을 통과한다. 임의 params는 버리지 않고 거절한다.
  z.object({ kind: z.enum(REPORT_KEYS), params: filterSchema.default({}) }).strict()
    .transform(({ kind, params }) => ({ reportKey: kind, filter: params })),
]);
export const MAX_EXPORT_ROWS = 100000;

function formatter(tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new ApiError('VALIDATION_ERROR', '유효한 IANA 시간대가 필요합니다.'); }
}
function parts(format, instant) {
  return Object.fromEntries(format.formatToParts(instant).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
export function localDate(instant, tz) {
  const p = parts(formatter(tz), instant);
  return `${p.year.padStart(4, '0')}-${p.month}-${p.day}`;
}
// 자정의 가능한 오프셋을 검증한다. DST 중복은 첫 자정, 존재하지 않는 날짜/자정은 400이다.
function midnight(value, tz) {
  const format = formatter(tz), wall = Date.parse(value + 'T00:00:00Z'), offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = wall + hours * 3600000, p = parts(format, sample);
    // 경계 주변 표본은 5자리 연도까지 갈 수 있다. ISO 문자열의 4자리 연도 제한을 피한다.
    const local = new Date(0);
    local.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
    local.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
    offsets.add(local.getTime() - sample);
  }
  const matches = [...offsets].map(offset => wall - offset).filter(instant => {
    const p = parts(format, instant);
    return `${p.year.padStart(4, '0')}-${p.month}-${p.day}` === value && p.hour === '00' && p.minute === '00' && p.second === '00';
  });
  if (!matches.length) throw new ApiError('VALIDATION_ERROR', '이 시간대에 존재하지 않는 기간 경계입니다.');
  return new Date(Math.min(...matches)).toISOString();
}
export function analyticsPeriod(input, now = new Date()) {
  const parsed = filterSchema.parse(input), tz = parsed.tz;
  formatter(tz);
  let { from, to } = parsed;
  if ((from === undefined) !== (to === undefined)) throw new ApiError('VALIDATION_ERROR', 'from/to를 함께 지정하세요.');
  if (!from) {
    const today = localDate(now, tz), year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
    from = today.slice(0, 7) + '-01';
    to = `${String(month === 12 ? year + 1 : year).padStart(4, '0')}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
    date.parse(to);
  }
  if (from >= to) throw new ApiError('VALIDATION_ERROR', '기간은 from < to여야 합니다.');
  return { period: { from, to, tz }, start: midnight(from, tz), end: midnight(to, tz) };
}
export function decimalMinor(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error('Invalid exact ledger decimal');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
}
export function decimal(value) {
  const negative = value < 0n, absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export function executionRate(numerator, denominator) {
  if (denominator === 0n) return null;
  const scaled = numerator * 1000000n / denominator, negative = scaled < 0n, absolute = negative ? -scaled : scaled;
  return `${negative ? '-' : ''}${absolute / 10000n}.${String(absolute % 10000n).padStart(4, '0')}`;
}
export function assertExportSize(rows) {
  if (rows.length > MAX_EXPORT_ROWS) throw new ApiError('EXPORT_LIMIT_EXCEEDED', '100000행을 초과했습니다. 기간을 좁히세요.', { limit: MAX_EXPORT_ROWS }, 413);
  return rows;
}
export function reportKey(value) { return z.enum(REPORT_KEYS).parse(value); }
export function csv(rows, columns) {
  const escape = value => {
    let text = value == null ? '' : String(value);
    // CSV 셀 수식 실행 방지. 숫자/정확 금액은 원래 표현을 유지한다.
    if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d+(\.\d+)?$/.test(text))) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(','), ...rows.map(row => columns.map(column => escape(row[column])).join(','))].join('\r\n');
}
