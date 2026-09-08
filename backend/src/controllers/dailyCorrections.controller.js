import { z } from 'zod';
import { transaction } from '../config/db.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { bumpVersion, getScoped, insert } from '../models/base.js';
import * as audit from '../services/audit.service.js';
import { assertCorrectionMember, assertCorrectionVersion, correctionVersion } from '../services/daily-corrections.service.js';
import { ApiError } from '../utils/errors.js';

const custodySchema = z.object({ version: correctionVersion,
  custodian_id: z.string().min(1).nullable().optional(),
  status: z.enum(['available', 'loaned', 'repairing', 'lost', 'damaged', 'disposed']).optional(),
}).strict().refine(value => value.custodian_id !== undefined || value.status !== undefined, '변경할 내용을 입력하세요');

export function changeAssetCustody(req, res) {
  const principal = resolvePrincipal(req); principal.require('asset.write');
  const { version, ...changes } = custodySchema.parse(req.body);
  const before = getScoped('asset', principal, req.params.assetId, 'asset');
  assertCorrectionVersion(before, version);
  if (before.status === 'disposed') throw new ApiError('CONFLICT', '폐기된 자산은 변경할 수 없습니다');
  if (changes.custodian_id !== undefined) assertCorrectionMember(principal, changes.custodian_id);
  const after = transaction(() => {
    const row = bumpVersion('asset', before, changes, principal.userId);
    insert('asset_history', { tenant_id: principal.tenantId, asset_id: row.id, action: 'custody.updated',
      actor_id: principal.userId, created_by: principal.userId,
      detail: JSON.stringify({ before: { custodian_id: before.custodian_id, status: before.status }, after: { custodian_id: row.custodian_id, status: row.status } }) });
    audit.record({ tenantId: principal.tenantId, action: 'asset.custody.updated', resourceType: 'asset', resourceId: row.id,
      actorId: principal.userId, before, after: row, requestId: req.requestId });
    return row;
  })();
  res.json(after);
}

export function cancelCalendarEvent(req, res) {
  const principal = resolvePrincipal(req); principal.require('event.write');
  const { version } = z.object({ version: correctionVersion }).strict().parse(req.body);
  const before = getScoped('event', principal, req.params.eventId, 'event');
  assertCorrectionVersion(before, version);
  const after = transaction(() => {
    const row = bumpVersion('event', before, { deleted_at: new Date().toISOString() }, principal.userId);
    audit.record({ tenantId: principal.tenantId, action: 'event.cancelled', resourceType: 'event', resourceId: row.id,
      actorId: principal.userId, before, after: row, requestId: req.requestId });
    return row;
  })();
  res.json({ id: after.id, cancelled: true, version: after.version });
}
