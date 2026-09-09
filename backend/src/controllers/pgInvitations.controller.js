import { z } from 'zod';
import { pgQuery, pgTransaction } from '../config/pg.js';
import { pgIdentity, resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { mutatePgRoles, pgRoleDefinitions, pgRoleMembers } from '../services/pg-company-roles.service.js';
import { assertDelegation, resolveRoleKeys, roleGrants } from '../services/company-roles.service.js';
import { ApiError } from '../utils/errors.js';
import { invitationToken } from '../utils/invitation-token.js';

const createSchema = z.object({
  email: z.string().trim().email().max(254), roles: z.array(z.string().min(1)).max(50).default([]),
  department_id: z.string().regex(/^[1-9]\d*$/).nullish(), position_id: z.string().regex(/^[1-9]\d*$/).nullish(),
  expires_in_days: z.number().int().min(1).max(30).default(7),
});
const tokenSchema = z.object({ token: z.string().min(1).max(500) }).strict();
const view = row => ({ invitation_id: String(row.id), email: row.email, org_id: `pg:${row.company_id}`,
  org_name: row.company_name, org_type: 'perp_db', roles: row.roles, status: row.status,
  expires_at: new Date(row.expires_at).toISOString() });

function inviteRoles(roles, keys) {
  // Invitation rows hold actual company role IDs, never virtual/global presets.
  const selected = resolveRoleKeys(roles, keys);
  if (selected.some(role => !/^[1-9]\d*$/.test(role.key))) throw new ApiError('VALIDATION_ERROR', '회사의 실제 역할을 선택하세요');
  return selected;
}
function check(row, email) {
  if (!row) return { valid: false, reason: 'not_found', message: '초대를 찾을 수 없습니다.' };
  let reason = 'ok', message = '사용할 수 있는 초대입니다.';
  if (row.email.toLowerCase() !== email.toLowerCase()) { reason = 'email_mismatch'; message = '초대받은 이메일의 계정으로 로그인하세요.'; }
  else if (row.status !== 'pending') { reason = row.status; message = '이미 처리된 초대입니다.'; }
  else if (new Date(row.expires_at).getTime() <= Date.now()) { reason = 'expired'; message = '초대 유효기간이 지났습니다.'; }
  else if (!row.company_active) { reason = 'company_inactive'; message = '활성 조직이 아닙니다.'; }
  return { valid: reason === 'ok', reason, message, ...(reason !== 'email_mismatch' ? { invitation: view(row) } : {}) };
}
async function load(token, query = pgQuery) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  return (await query(`SELECT i.*, c.name AS company_name, c.is_active AS company_active
    FROM org.member_invites i JOIN org.companies c ON c.id = i.company_id WHERE i.token = $1::uuid`, [token])).rows[0];
}
async function recipient(req) {
  const { userId } = pgIdentity(req);
  const { rows } = await pgQuery('SELECT email FROM auth.users WHERE id = $1', [userId]);
  return { userId, email: rows[0].email };
}

export async function options(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  principal.require('member.write'); principal.require('role.assign');
  const roles = await pgRoleDefinitions(principal.companyId);
  res.json({ items: roles.filter(role => {
    if (!/^[1-9]\d*$/.test(role.key)) return false;
    try { assertDelegation(principal, [role]); return true; }
    catch (error) { if (error instanceof ApiError && error.code === 'PERMISSION_DENIED') return false; throw error; }
  }).map(role => ({ key: role.key, label: role.label, scope: role.scope })) });
}

export async function create(req, res) {
  const principal = await resolvePgCompanyPrincipal(req), payload = createSchema.parse(req.body);
  const email = payload.email.toLowerCase(), keys = [...new Set(payload.roles)];
  const result = await mutatePgRoles(principal, req.requestId, async ({ query, roles, authority }) => {
    authority.require('member.write'); assertDelegation(authority, inviteRoles(roles, keys));
    for (const [table, id] of [['departments', payload.department_id], ['positions', payload.position_id]]) {
      if (id && !(await query(`SELECT id FROM org.${table} WHERE id = $1 AND company_id = $2`, [id, principal.companyId])).rows[0]) throw new ApiError('VALIDATION_ERROR', '선택한 회사의 부서/직급이 아닙니다');
    }
    await query("UPDATE org.member_invites SET status = 'expired' WHERE company_id = $1 AND lower(email) = $2 AND status = 'pending' AND expires_at <= now()", [principal.companyId, email]);
    if ((await query("SELECT id FROM org.member_invites WHERE company_id = $1 AND lower(email) = $2 AND status = 'pending'", [principal.companyId, email])).rows[0]) throw new ApiError('CONFLICT', '대기 중인 초대가 있습니다. 기존 초대를 취소한 뒤 새로 만드세요.');
    const { rows } = await query(`INSERT INTO org.member_invites (company_id,email,roles,department_id,position_id,invited_by,expires_at)
      VALUES ($1,$2,$3::text[],$4,$5,$6,now() + $7 * interval '1 day') RETURNING *`,
    [principal.companyId, email, keys, payload.department_id ?? null, payload.position_id ?? null, principal.userId, payload.expires_in_days]);
    const row = rows[0], company = (await query('SELECT name FROM org.companies WHERE id = $1', [principal.companyId])).rows[0];
    return { action: 'member.invited', resourceId: String(row.id), after: { email, roles: keys }, value: { ...view({ ...row, company_name: company.name }), token: row.token, delivery: 'manual' } };
  }, 'menu.members');
  res.status(201).set('Cache-Control', 'no-store').json(result);
}

export async function verify(req, res) {
  const user = await recipient(req), token = invitationToken(tokenSchema.parse(req.body).token);
  res.set('Cache-Control', 'no-store').json(check(await load(token), user.email));
}

export async function accept(req, res) {
  const user = await recipient(req), token = invitationToken(tokenSchema.parse(req.body).token);
  const initial = await load(token);
  if (!initial) throw new ApiError('NOT_FOUND', '초대를 찾을 수 없습니다', { reason: 'not_found' });
  const value = await pgTransaction(async client => {
    const query = client.query.bind(client);
    // Same lock order as all role mutations: company then invitation/membership.
    await query('SELECT id FROM org.companies WHERE id = $1 FOR UPDATE', [initial.company_id]);
    const row = await load(token, query), checked = check(row, user.email);
    const membership = (await query('SELECT status FROM org.company_memberships WHERE company_id = $1 AND user_id = $2', [row.company_id, user.userId])).rows[0];
    if (row.status === 'accepted' && String(row.accepted_by) === user.userId && row.company_active && membership?.status === 'active' && row.email.toLowerCase() === user.email.toLowerCase()) return view(row);
    if (!checked.valid) throw new ApiError('VALIDATION_ERROR', checked.message, { reason: checked.reason });
    if (membership) throw new ApiError('CONFLICT', '기존 소속은 초대로 변경할 수 없습니다. 조직 관리자에게 문의하세요.');
    const roles = await pgRoleDefinitions(String(row.company_id), query), members = await pgRoleMembers(String(row.company_id), query);
    const inviter = members.find(member => member.user_id === String(row.invited_by));
    if (!inviter) throw new ApiError('PERMISSION_DENIED', '초대한 관리자의 활성 소속이 없습니다');
    const grants = roleGrants(roles, inviter.roles);
    const authority = { ...grants, has: code => grants.permissions.has(code), require(code) { if (!this.has(code)) throw new ApiError('PERMISSION_DENIED', '초대한 관리자의 권한이 변경되었습니다'); } };
    authority.require('member.write'); authority.require('menu.members');
    assertDelegation(authority, inviteRoles(roles, row.roles));
    await query(`INSERT INTO org.company_memberships(company_id,user_id,department_id,position_id,created_by)
      VALUES ($1,$2,$3,$4,$5)`, [row.company_id, user.userId, row.department_id, row.position_id, row.invited_by]);
    for (const key of new Set(row.roles)) await query('INSERT INTO org.user_roles(user_id,role_id,granted_by) VALUES ($1,$2,$3)', [user.userId, key, row.invited_by]);
    await query("UPDATE org.member_invites SET status = 'accepted', accepted_by = $2, accepted_at = now() WHERE id = $1", [row.id, user.userId]);
    await query(`INSERT INTO org.role_change_events(company_id,actor_id,action,resource_id,after_data,request_id)
      VALUES ($1,$2,'member.invitation.accepted',$3,$4::jsonb,$5)`, [row.company_id, user.userId, String(row.id), JSON.stringify({ user_id: user.userId, roles: row.roles }), req.requestId ?? null]);
    return view({ ...row, status: 'accepted' });
  });
  res.status(201).set('Cache-Control', 'no-store').json({ joined: true, ...value });
}

export async function revoke(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const id = z.string().regex(/^[1-9]\d*$/).parse(req.params.id);
  await mutatePgRoles(principal, req.requestId, async ({ query, roles, authority }) => {
    authority.require('member.write');
    const row = (await query('SELECT * FROM org.member_invites WHERE company_id = $1 AND id = $2', [principal.companyId, id])).rows[0];
    if (!row) throw new ApiError('NOT_FOUND', '초대를 찾을 수 없습니다');
    assertDelegation(authority, inviteRoles(roles, row.roles));
    if (row.status === 'revoked') return { noop: true, value: null };
    if (row.status !== 'pending') throw new ApiError('CONFLICT', '이미 처리된 초대입니다');
    await query("UPDATE org.member_invites SET status = 'revoked' WHERE id = $1", [id]);
    return { action: 'member.invitation.revoked', resourceId: id, before: { status: row.status }, after: { status: 'revoked' }, value: null };
  }, 'menu.members');
  res.json({ ok: true });
}
