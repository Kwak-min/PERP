import { principal as legacyPrincipal } from './auth.controller.js';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';

// 예약 서비스 전용 계약. 전역/레거시 principal과 회사 소속은 변경하지 않는다.
export async function reservationPrincipal(req, res) {
  if (!req.get('x-org-id')?.startsWith('pg:')) return legacyPrincipal(req, res);
  const principal = await resolvePgCompanyPrincipal(req);
  res.json({
    userId: `pg:${principal.userId}`,
    tenantId: principal.orgId,
    orgId: principal.orgId,
    membershipId: `${principal.orgId}:${principal.userId}`,
    roles: principal.roles,
    permissions: [...principal.permissions].sort(),
    modules: [...principal.modules].sort(),
  });
}
