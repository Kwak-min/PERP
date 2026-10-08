import { z } from 'zod';
import { pgTransaction } from '../config/pg.js';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { ApiError } from '../utils/errors.js';

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).default('') }).strict();

// Compatibility decision path for pre-v14 immediately submitted requests.
export async function decidePgApproval(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  principal.require('approval.decide');
  const id = z.string().regex(/^[1-9]\d*$/).parse(req.params.id);
  const payload = decisionSchema.parse(req.body);
  const status = payload.decision === 'approve' ? 'approved' : 'rejected';
  const result = await pgTransaction(async client => {
    await client.query('SELECT id FROM org.companies WHERE id=$1 AND is_active=true FOR UPDATE', [principal.companyId]);
    const { rows } = await client.query(`SELECT id,status,(to_jsonb(ar)->>'workflow_locked')::boolean AS workflow_locked
      FROM org.approval_requests ar WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, principal.companyId]);
    if (!rows[0]) throw new ApiError('NOT_FOUND', '결재 요청을 찾을 수 없습니다');
    if (rows[0].status !== 'pending') throw new ApiError('CONFLICT', '이미 처리된 결재 요청입니다');
    if (rows[0].workflow_locked) throw new ApiError('CONFLICT', '전용 결재는 snapshot 보존 actions 경로에서 결정해야 합니다.');
    await client.query(`UPDATE org.approval_requests SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE id = $1 AND company_id = $2`, [id, principal.companyId, status, principal.userId, payload.comment]);
    await client.query(`INSERT INTO org.role_change_events (company_id, actor_id, action, resource_id, before_data, after_data, request_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`, [principal.companyId, principal.userId, 'approval.decided', id,
      JSON.stringify({ status: 'pending' }), JSON.stringify({ status }), req.requestId]);
    return { id, status };
  });
  res.json(result);
}
