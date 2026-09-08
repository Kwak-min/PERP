import { z } from 'zod';
import { pgQuery } from '../config/pg.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { ApiError } from '../utils/errors.js';
import { money, cents, decimal, expectedVersion, idempotentMutation, financialRecord, recordEvent } from '../services/pg-finance.service.js';

const idSchema = z.string().regex(/^[1-9]\d*$/);
const paymentSchema = z.object({
  amount: z.union([z.string(), z.number()]).transform(money),
  expected_version: z.number().int().positive().safe(),
  paid_on: z.string().date().optional(),
  method: z.string().trim().max(100).default('manual'),
}).strict();

export async function duesPaymentHistory(req, res) {
  const { companyId } = pgIdentity(req), id = idSchema.parse(req.params.id);
  // A single statement gives the charge version and all payments one MVCC snapshot.
  const { rows } = await pgQuery(`SELECT c.id, c.amount::text, c.status, c.version,
    COALESCE(SUM(p.amount),0)::numeric(18,2)::text AS paid,
    (c.amount-COALESCE(SUM(p.amount),0))::numeric(18,2)::text AS outstanding,
    COALESCE(jsonb_agg(jsonb_build_object('id',p.id::text,'amount',p.amount::text,
      'paid_on',p.paid_on,'method',p.method,'recorded_by',p.recorded_by::text,'created_at',p.created_at)
      ORDER BY p.id) FILTER(WHERE p.id IS NOT NULL),'[]'::jsonb) AS items
    FROM accounting.dues_charges c LEFT JOIN accounting.dues_payments p ON p.charge_id=c.id
    WHERE c.id=$1 AND c.company_id=$2 GROUP BY c.id`, [id,companyId]);
  if (!rows[0]) throw new ApiError('NOT_FOUND', '청구를 찾을 수 없습니다');
  res.json({ ...rows[0], id: String(rows[0].id) });
}

// Records an offline/manual payment only. No transfer or external provider call.
export async function recordDuesPayment(req, res) {
  const { companyId, userId } = pgIdentity(req), id = idSchema.parse(req.params.id);
  const payload = paymentSchema.parse(req.body);
  const response = await idempotentMutation(req, `dues.payment:${id}`, payload, async client => {
    const before = await financialRecord(client, companyId, 'dues', id);
    if (Number(before.version) !== expectedVersion(payload.expected_version)) throw new ApiError('VERSION_CONFLICT', '청구가 변경되었습니다. 새로고침 후 다시 시도하세요');
    if (['paid','waived'].includes(before.status)) throw new ApiError('CONFLICT', '이미 완료된 청구입니다');
    const { rows } = await client.query('SELECT COALESCE(SUM(amount),0)::numeric(18,2)::text AS paid FROM accounting.dues_payments WHERE charge_id=$1', [id]);
    const remaining = cents(before.amount) - cents(rows[0].paid) - cents(payload.amount);
    if (remaining < 0n) throw new ApiError('VALIDATION_ERROR', '납부액이 잔액보다 큽니다');
    const payment = await client.query(`INSERT INTO accounting.dues_payments(charge_id,amount,paid_on,method,recorded_by)
      VALUES($1,$2,COALESCE($3::date,CURRENT_DATE),$4,$5) RETURNING id`, [id,payload.amount,payload.paid_on ?? null,payload.method,userId]);
    const status = remaining === 0n ? 'paid' : 'partial';
    const updated = await client.query(`UPDATE accounting.dues_charges SET status=$3,version=version+1
      WHERE id=$1 AND company_id=$2 RETURNING *`, [id,companyId,status]);
    await recordEvent(client, req, 'dues.payment', id, before, { ...updated.rows[0], payment_id: String(payment.rows[0].id), payment_amount: payload.amount });
    return { id: String(payment.rows[0].id), charge_id: id, status, outstanding: decimal(remaining), version: Number(updated.rows[0].version) };
  });
  res.status(201).json(response);
}
