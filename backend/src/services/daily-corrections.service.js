import { z } from 'zod';
import { db } from '../config/db.js';
import { ApiError } from '../utils/errors.js';

export const correctionVersion = z.number().int().positive().safe();
export const correctionDate = z.string().date().nullable();
export function assertCorrectionWindow(start, end) {
  if (start && end && Date.parse(end) < Date.parse(start)) {
    throw new ApiError('VALIDATION_ERROR', '종료일은 시작일보다 빠를 수 없습니다');
  }
}
export function assertCorrectionVersion(row, version) {
  if (row.version !== version) throw new ApiError('VERSION_CONFLICT', '다른 사용자가 변경했습니다. 입력을 보관하고 최신 내용을 확인하세요.');
}
export function assertCorrectionMember(principal, userId) {
  if (userId === null) return;
  const member = db().prepare(`SELECT m.id FROM membership m JOIN app_user u ON u.id = m.user_id
    WHERE m.tenant_id = ? AND m.org_id = ? AND m.user_id = ?
      AND m.status = 'active' AND m.deleted_at IS NULL AND u.auth_status = 'active'`).get(principal.tenantId, principal.orgId, userId);
  if (!member) throw new ApiError('PERMISSION_DENIED', '현재 조직의 활성 구성원만 담당자로 지정할 수 있습니다');
}
