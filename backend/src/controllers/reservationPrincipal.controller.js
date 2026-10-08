import { principal as legacyPrincipal } from './auth.controller.js';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { resolvePrincipal } from '../middleware/auth.js';

// 예약 서비스 전용 계약. 전역/레거시 principal과 회사 소속은 변경하지 않는다.
export async function reservationPrincipal(req, res) {
  if (!req.get('x-org-id')?.startsWith('pg:')) {
    if (req.get('x-org-id')) resolvePrincipal(req).require('menu.reservations');
    return legacyPrincipal(req, res);
  }
  const principal = await resolvePgCompanyPrincipal(req);
  principal.require('menu.reservations');
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
