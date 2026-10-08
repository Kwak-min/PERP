import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { startDeadlineServer } from './deadline-fixture.js';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';

let server, db;
before(async () => { server = await startDeadlineServer(); ({ db } = await import('../src/config/db.js')); });
after(async () => { await server?.close(); });
const req = (...args) => server.request(...args);
async function fixture() {
  const suffix = crypto.randomUUID();
  const signup = await req(null, '/auth/signup', 'POST', { email: `${suffix}@example.invalid`, name: '역할 검증', password: 'password-1234' }, 201);
  const admin = { token: signup.access_token, userId: signup.user.id };
  const company = await req(admin, '/tenants', 'POST', { name: suffix, type: 'custom', modules: ['imports', 'hr', 'tasks'], features: [], departments: [] }, 201);
  admin.orgId = company.org_id;
  const own = (await req(admin, '/members')).items[0];
  const invite = await req(admin, '/members/invites', 'POST', { email: `member-${suffix}@example.invalid`, roles: ['member'] }, 201);
  const joined = await req(null, '/auth/signup', 'POST', { email: invite.email, name: '구성원', password: 'password-1234', invitation_token: invite.token }, 201);
  const member = { token: joined.access_token, userId: joined.user.id, orgId: admin.orgId };
  const membership = (await req(admin, '/members')).items.find(row => row.user_id === member.userId);
  const create = (name, permissions, scope = 'all') => req(admin, '/settings/roles', 'POST', { name, permissions, scope }, 201);
  const assign = async (target, roles, expected = 200) => {
    const current = (await req(admin, '/settings/members')).items.find(row => row.membership_id === target);
    return req(admin, `/settings/members/${target}/roles`, 'PUT', { roles, expected_roles_version: current.roles_version }, expected);
  };
  return { admin, member, own, membership, create, assign };
}
const snapshot = () => JSON.stringify(['company_role','membership','invitation','app_user','import_job','audit_event'].map(table => db().prepare(`SELECT * FROM ${table} ORDER BY id`).all()));

test('definition CAS and independent membership CAS: malformed, missing, stale and no-op are write-free', async () => {
  const f = await fixture();
  const role = await f.create('버전 역할', ['task.read']);
  assert.equal(role.version, 1); assert.equal(role.id, role.key);
  const path = `/settings/roles/${role.key}`, payload = { name: role.name, scope: role.scope, permissions: role.permissions };
  for (const version of [undefined, 0, '1', 1.5, null]) {
    const before = snapshot();
    await req(f.admin, path, 'PATCH', { ...payload, ...(version === undefined ? {} : { expected_version: version }) }, 400);
    assert.equal(snapshot(), before);
  }
  const beforeNoop = snapshot();
  await req(f.admin, path, 'PATCH', { ...payload, expected_version: 1 });
  assert.equal(snapshot(), beforeNoop);
  const changed = await req(f.admin, path, 'PATCH', { ...payload, name: '변경', expected_version: 1 });
  assert.equal(changed.version, 2);
  for (const method of ['PATCH','DELETE']) {
    const before = snapshot();
    await req(f.admin, path, method, method === 'PATCH' ? { ...payload, expected_version: 1 } : { expected_version: 1 }, 409);
    assert.equal(snapshot(), before);
  }
  const assigned = await f.assign(f.membership.membership_id, [role.key]);
  assert.equal(assigned.roles_version, 2);
  const before = snapshot();
  await req(f.admin, `/members/${f.membership.membership_id}/roles`, 'PATCH', { roles: ['member'], expected_roles_version: 1 }, 409);
  await req(f.admin, `/members/${f.membership.membership_id}/roles`, 'PATCH', { roles: [role.key], expected_roles_version: 2 });
  assert.equal(snapshot(), before);
  await req(f.admin, path, 'DELETE', { expected_version: 2 }, 204);
  const member = (await req(f.admin, '/settings/members')).items.find(row => row.membership_id === f.membership.membership_id);
  assert.equal(member.roles_version, 3); assert.deepEqual(member.roles, []);
});

test('role.assign gates every surface including immediate and commit member CSV; revoked actor precedes stale validation', async () => {
  const f = await fixture();
  const limited = await f.create('위임 없음', ['menu.roles','menu.members','menu.imports','member.write']);
  const csv = `email,name,roles\nimport-${crypto.randomUUID()}@example.invalid,가져오기,member`;
  const preview = await req(f.admin, '/imports', 'POST', { kind: 'members', csv }, 201);
  const invitation = await req(f.admin, '/members/invites', 'POST', {email:`revoke-${crypto.randomUUID()}@example.invalid`,roles:['member']},201);
  await f.assign(f.membership.membership_id, [limited.key]);
  for (const [route, method, body] of [
    ['/settings/roles','POST',{name:'불가', permissions:[]}],
    [`/settings/roles/${limited.key}`,'PATCH',{name:'불가',permissions:[],expected_version:0}],
    [`/settings/roles/${limited.key}`,'DELETE',{expected_version:0}],
    [`/settings/members/${f.own.membership_id}/roles`,'PUT',{roles:[],expected_roles_version:0}],
    [`/members/${f.own.membership_id}/roles`,'PATCH',{roles:[],expected_roles_version:0}],
    ['/members/invites','POST',{email:'no-invite@example.invalid',roles:['member']}],
    ['/members/provision','POST',{email:'no-provision@example.invalid',name:'금지',roles:['member']}],
    [`/members/invites/${invitation.id}/revoke`,'POST',{}],
    ['/imports','POST',{kind:'members',csv,dry_run:false}],
    [`/imports/${preview.id}/commit`,'POST',{csv}],
  ]) { const before = snapshot(); await req(f.member, route, method, body, 403); assert.equal(snapshot(), before); }
});

test('CSV resolves all roles before writes, rejects foreign/platform/wildcard/unknown and preserves existing membership', async () => {
  const f = await fixture(), foreign = await fixture();
  const role = await foreign.create('외부 역할', []);
  for (const key of ['*','platform_admin','owner','unknown',role.key]) {
    const csv = `email,name,roles\nvalid-${crypto.randomUUID()}@example.invalid,정상,member\nbad-${crypto.randomUUID()}@example.invalid,불가,${key}`;
    const before = snapshot();
    await req(f.admin, '/imports', 'POST', { kind:'members', csv, dry_run:false }, ['platform_admin','owner'].includes(key) ? 403 : 400);
    assert.equal(snapshot(), before);
  }
  const email = db().prepare('SELECT email FROM app_user WHERE id=?').get(f.member.userId).email;
  const before = db().prepare('SELECT * FROM membership WHERE id=?').get(f.membership.membership_id);
  await req(f.admin, '/imports', 'POST', { kind:'members', csv:`email,name,roles\n${email},변경 금지,company_admin`, dry_run:false }, 201);
  assert.deepEqual(db().prepare('SELECT * FROM membership WHERE id=?').get(f.membership.membership_id), before);
});

test('full administrator means active all-scope union of every permission, including disabled features', async () => {
  const f = await fixture();
  const half = Math.ceil(COMPANY_PERMISSIONS.length / 2);
  const a = await f.create('합집합 A', COMPANY_PERMISSIONS.slice(0, half));
  const b = await f.create('합집합 B', COMPANY_PERMISSIONS.slice(half));
  await f.assign(f.membership.membership_id, [a.key,b.key]);
  await f.assign(f.own.membership_id, ['member']);
  const before = snapshot();
  await req(f.member, `/settings/roles/${a.key}`, 'PATCH', { name:a.name,scope:'all',permissions:[],expected_version:a.version }, 409);
  await req(f.member, `/members/${f.membership.membership_id}/status`, 'PATCH', { status:'inactive',expected_roles_version:2 }, 409);
  assert.equal(snapshot(), before);
  const roles = await req(f.member, '/settings/roles'); assert.equal(roles.recovery_required, false);
  const features = (await req(f.member, '/settings/access')).features; assert.ok(!features.includes('attendance')); assert.ok(!features.includes('leave'));
});

test('legacy three-permission admin is recovery-required, never auto-promoted or mistaken for fulladmin', async () => {
  const f = await fixture();
  const self = await f.create('개인 범위 전체 권한', COMPANY_PERMISSIONS, 'self');
  await f.assign(f.membership.membership_id, [self.key]);
  await f.assign(f.own.membership_id, [], 409);
  const narrow = await f.create('부분 관리자', ['role.assign','organization.settings','menu.roles']);
  await f.assign(f.membership.membership_id, [narrow.key]);
  await f.assign(f.own.membership_id, [], 409);
  db().prepare("UPDATE app_user SET auth_status='inactive' WHERE id=?").run(f.admin.userId);
  const before = snapshot();
  assert.equal((await req(f.member, '/settings/roles')).recovery_required, true);
  assert.equal(snapshot(), before);
});

test('role.assign never bypasses the existing settings/member/import surface gates', async () => {
  const f = await fixture();
  const settingsOnly = await f.create('설정 위임', ['role.assign','menu.roles','member.write']);
  await f.assign(f.membership.membership_id, [settingsOnly.key]);
  const before = snapshot();
  await req(f.member, '/members/invites', 'POST', {email:'surface@example.invalid',roles:[]},403);
  await req(f.member, '/imports', 'POST', {kind:'members',csv:'email,name,roles\nsurface@example.invalid,불가,member',dry_run:false},403);
  assert.equal(snapshot(),before);
  const memberOnly = await f.create('구성원 위임', COMPANY_PERMISSIONS.filter(code=>code!=='menu.roles'));
  await f.assign(f.membership.membership_id,[memberOnly.key]);
  await req(f.member, '/settings/roles', 'GET', undefined,403);
  const listed = (await req(f.member,'/members')).items.find(row=>row.user_id===f.member.userId);
  await req(f.member,`/members/${listed.membership_id}/roles`,'PATCH',{roles:[],expected_roles_version:listed.roles_version});
});

test('invitation acceptance revalidates inviter current delegation and role definition without partial signup', async () => {
  const f = await fixture();
  const delegator = await f.create('초대 위임', COMPANY_PERMISSIONS);
  await f.assign(f.membership.membership_id, [delegator.key]);
  const email = `stale-${crypto.randomUUID()}@example.invalid`;
  const invitation = await req(f.member, '/members/invites', 'POST', { email, roles:['member'] }, 201);
  await f.assign(f.membership.membership_id, ['member']);
  const before = snapshot();
  await req(null, '/auth/signup', 'POST', { email,name:'지연 가입',password:'password-1234',invitation_token:invitation.token }, 403);
  assert.equal(snapshot(), before);
});
