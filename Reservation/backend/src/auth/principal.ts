import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { AppError, ForbiddenError } from '../common/errors';

export const principalSchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  orgId: z.string().min(1),
  membershipId: z.string().min(1),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  modules: z.array(z.string()),
});
const principalResponseSchema = z.union([principalSchema, z.object({ data: principalSchema })]).transform(value => 'data' in value ? value.data : value);
export type Principal = Readonly<z.infer<typeof principalSchema>>;
export type OrganizationScope = Readonly<Pick<Principal, 'tenantId' | 'orgId'>>;
const principals = new WeakMap<Request, Principal>();

export function principalOf(req: Request): Principal {
  const principal = principals.get(req);
  if (!principal) throw new AppError(401, '로그인이 필요합니다.');
  return principal;
}

export function organizationScope(principal: OrganizationScope): OrganizationScope {
  return { tenantId: principal.tenantId, orgId: principal.orgId };
}

export function requireSpaceAdmin(principal: Principal): void {
  if (!principal.roles.some(role => role === 'owner' || role === 'org_admin')) {
    throw new ForbiddenError('공간 관리는 조직 관리자만 이용할 수 있습니다.');
  }
}

export function requireReservationWrite(principal: Principal): void {
  if (!principal.permissions.includes('*') && !principal.permissions.includes('reservation.create')) {
    throw new ForbiddenError('예약을 변경할 권한이 없습니다.');
  }
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const authorization = req.get('authorization');
  const orgId = req.get('x-org-id');
  if (!authorization?.startsWith('Bearer ') || !orgId) return next(new AppError(401, '검증된 ERP 세션이 필요합니다.'));
  try {
    const response = await axios.get(`${process.env.ERP_API_URL ?? 'http://localhost:8000/api/v1'}/auth/principal`, {
      headers: { Authorization: authorization, 'X-Org-Id': orgId }, timeout: 3000, validateStatus: () => true,
    });
    if (response.status === 401) return next(new AppError(401, '검증된 ERP 세션이 필요합니다.'));
    if (response.status === 403) return next(new ForbiddenError('선택한 조직에 접근할 수 없습니다.'));
    if (response.status !== 200) return next(new AppError(503, 'ERP 인증 서비스를 사용할 수 없습니다.'));
    const principal = principalResponseSchema.parse(response.data);
    if (principal.orgId !== orgId) return next(new ForbiddenError('선택한 조직이 검증 결과와 일치하지 않습니다.'));
    if (!principal.modules.includes('assets')) {
      return next(new ForbiddenError('예약 기능을 사용할 권한이 없습니다.'));
    }
    principals.set(req, principal);
    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error instanceof z.ZodError) return next(new AppError(503, 'ERP 인증 응답이 올바르지 않습니다.'));
    next(new AppError(503, 'ERP 인증 서비스를 사용할 수 없습니다.'));
  }
};
