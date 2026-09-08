import { z } from 'zod';
import { pgTransaction } from '../config/pg.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { ApiError } from '../utils/errors.js';

// NUMERIC(18,2): never round through binary floating point at the boundary.
export function money(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100)) {
    throw new ApiError('VALIDATION_ERROR', '큰 금액은 소수 문자열로 입력하세요');
  }
  const text = String(value ?? '');
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(text)) throw new ApiError('VALIDATION_ERROR', '금액은 소수점 두 자리 이내의 양수여야 합니다');
  const [whole, fraction = ''] = text.split('.');
  const normalized = `${whole}.${fraction.padEnd(2, '0')}`;
  if (cents(normalized) <= 0n) throw new ApiError('VALIDATION_ERROR', '금액은 0보다 커야 합니다');
  return normalized;
}
export function cents(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function decimal(value) { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }
export const expectedVersion = value => z.number().int().positive().safe().parse(value);

export async function idempotentMutation(req, operation, payload, run) {
  return pgTransaction(client => replayPgMutation(client, req, { operation, payload }, run));
}

// 호출자가 transaction과 fresh 인가/회사 잠금을 소유한다. CSV도 전행에 한 번만 호출한다.
export async function replayPgMutation(client, req, { operation, payload }, run) {
  const { companyId, userId } = pgIdentity(req);
  const key = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/).parse(req.get('Idempotency-Key'));
    const scope = [companyId, userId, operation, key];
    await client.query(`INSERT INTO accounting.request_replays(company_id,actor_id,operation,request_key,payload)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, [...scope, JSON.stringify(payload)]);
    const { rows } = await client.query(`SELECT response, payload = $5::jsonb AS matches FROM accounting.request_replays
      WHERE company_id=$1 AND actor_id=$2 AND operation=$3 AND request_key=$4 FOR UPDATE`, [...scope, JSON.stringify(payload)]);
    if (!rows[0].matches) throw new ApiError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 내용이 사용되었습니다');
    if (rows[0].response !== null) return rows[0].response;
    const response = await run(client);
    await client.query(`UPDATE accounting.request_replays SET response=$5::jsonb
      WHERE company_id=$1 AND actor_id=$2 AND operation=$3 AND request_key=$4`, [...scope, JSON.stringify(response)]);
    return response;
}

export const MONEY_TABLES = {
  budgets: 'accounting.budgets', settlements: 'accounting.settlements',
  dues: 'accounting.dues_charges', transactions: 'accounting.journal_entries',
};
export async function financialRecord(client, companyId, resource, id) {
  const { rows } = await client.query(`SELECT * FROM ${MONEY_TABLES[resource]} WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, companyId]);
  if (!rows[0]) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없습니다');
  return rows[0];
}
export async function recordEvent(client, req, resource, id, before, after) {
  const { companyId, userId } = pgIdentity(req);
  await client.query(`INSERT INTO accounting.record_events(company_id,actor_id,resource,resource_id,before_data,after_data,request_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [companyId,userId,resource,String(id),JSON.stringify(before),JSON.stringify(after),req.requestId ?? null]);
}
export async function requireCorrectable(client, resource, row) {
  if (resource === 'transactions' && row.posted || resource === 'settlements' && (row.status !== 'pending' || row.journal_entry_id)) {
    throw new ApiError('CONFLICT', '확정된 금융 기록은 삭제하거나 덮어쓸 수 없습니다');
  }
  if (resource === 'dues') {
    const paid = await client.query('SELECT id FROM accounting.dues_payments WHERE charge_id=$1 LIMIT 1', [row.id]);
    if (paid.rows.length || ['paid','partial','waived'].includes(row.status)) throw new ApiError('CONFLICT', '납부 이력이 있는 청구는 보존해야 합니다');
  }
}

export async function mutateFinancialRecord(req, resource, id, sets, params, deleting = false) {
  const { companyId } = pgIdentity(req);
  const version = expectedVersion(req.body?.expected_version);
  return pgTransaction(async client => {
    const before = await financialRecord(client, companyId, resource, id);
    if (Number(before.version) !== version) throw new ApiError('VERSION_CONFLICT', '다른 곳에서 수정되었습니다. 새로고침 후 다시 시도하세요');
    await requireCorrectable(client, resource, before);
    const { rows } = await client.query(deleting
      ? `DELETE FROM ${MONEY_TABLES[resource]} WHERE id=$1 AND company_id=$2 RETURNING *`
      : `UPDATE ${MONEY_TABLES[resource]} SET ${sets.join(', ')}, version=version+1 WHERE id=$1 AND company_id=$2 RETURNING *`, params);
    await recordEvent(client, req, resource, id, before, deleting ? null : rows[0]);
    return { ok: true, ...(deleting ? {} : { version: Number(rows[0].version) }) };
  });
}
