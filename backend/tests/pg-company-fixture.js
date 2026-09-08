import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/utils/crypto.js';

// PG 서버 대체물이 아닌 SQL 경계 픽스처. 실제 HTTP/인증/권한/트랜잭션 코드를 실행한다.
export async function installCompanyFixture() {
  const { pgPool } = await import('../src/config/pg.js');
  const originalQuery = pgPool.query, originalConnect = pgPool.connect;
  const password_hash = hashPassword('password-1234');
  const users = [
    { id: '101', email: 'pg-member@example.invalid', company_id: '77', name: 'PG QA', department_id: null, position_id: null },
    { id: '102', email: 'pg-empty@example.invalid', company_id: null, name: 'PG Empty', department_id: null, position_id: null },
  ].map(user => ({ ...user, is_admin: true, account_status: 'active', approval_status: 'approved', password_hash }));
  let state = {
    users,
    companies: [{ id: '77', name: 'QA_PG_COMPANY', is_active: true }],
    memberships: [{ company_id: '77', user_id: '101', department_id: null, position_id: null, status: 'active' }],
    roles: [{ id: '1', company_id: '77', name: 'member' }],
    grants: [{ user_id: '101', role_id: '1' }],
    permissions: [{ role_id: '1', code: 'task.read' }],
    modules: [{ company_id: '77', module_key: 'tasks' }],
    featureSettings: [],
    departments: [], projects: [], tasks: [], events: [], orgEvents: [], sessions: [], logs: [], replays: [], duesCharges: [],
  };
  let failMembership = false, schemaAvailable = true, featureSchemaAvailable = true, failSettingsAudit = false;
  const queries = [];
  function bumpOrg(data, companyId) {
    const company = data.companies.find(c => c.id === companyId);
    company.org_revision = String(BigInt(company.org_revision ?? '1') + 1n);
  }
  function execute(data, sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: text, values });
    if (text === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') return { rows: [] };
    if (text.startsWith('SELECT id, org_revision FROM org.companies') || text.startsWith('SELECT org_revision FROM org.companies')) {
      return { rows: data.companies.filter(c => c.id === values[0] && c.is_active).map(c => ({ ...c, org_revision: c.org_revision ?? '1' })) };
    }
    if (text.includes('INSERT INTO org.organization_change_events')) {
      const actor = data.users.find(u => u.id === values[1]);
      data.orgEvents.push({ id: String(data.orgEvents.length + 1), company_id: values[0], actor_id: actor.id, actor_name: actor.name,
        action: values[2], resource_type: values[3], resource_id: values[4], target: values[5],
        before_data: values[6] === null ? null : JSON.parse(values[6]), after_data: JSON.parse(values[7]), request_id: values[8], created_at: '2026-09-08T00:00:00.000Z' });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM org.organization_change_events')) {
      return { rows: data.orgEvents.filter(e => e.company_id === values[0] && (!values[1] || (e.resource_type === 'member' && e.resource_id === values[1]))).reverse().slice(0, values[2]) };
    }
    if (text.includes('FROM auth.sessions s')) {
      const s = data.sessions.find(row => row.token === values[0] && row.active);
      return { rows: s ? [{ ...data.users.find(user => user.id === s.user_id), session_id: s.id, login_at: s.login_at }] : [] };
    }
    if (text.includes('WHERE lower(email) = lower($1)')) {
      const user = data.users.find(row => row.email.toLowerCase() === values[0].toLowerCase());
      if (text.startsWith('SELECT 1 FROM auth.users')) return { rows: user ? [user] : [] };
      if (!user) throw Object.assign(new Error('PG unavailable fixture for legacy accounts'), { code: 'ECONNREFUSED' });
      return { rows: [user] };
    }
    if (text.includes('INSERT INTO auth.users')) {
      const user = { id: String(101 + data.users.length), company_id: values[0], department_id: values[1], position_id: values[2], email: values[3], name: values[4], password_hash: values[text.includes('phone') ? 6 : 5], account_status: 'active', approval_status: /VALUES \([^']*'([^']+)'/.exec(text)?.[1], is_admin: /'approved', true/.test(text) };
      data.users.push(user); return { rows: [user], rowCount: 1 };
    }
    if (text.includes('INSERT INTO auth.sessions')) {
      const s = { id: randomUUID(), user_id: values[0], token: randomUUID(), login_at: new Date().toISOString(), active: true };
      data.sessions.push(s); return { rows: [{ session_token: s.token, login_at: s.login_at }] };
    }
    if (text.includes('UPDATE auth.sessions')) {
      for (const s of data.sessions) if (s.id === values[0]) s.active = false;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO auth.login_logs')) { data.logs.push(values); return { rows: [], rowCount: 1 }; }
    if (text.includes('FROM auth.users u') && text.includes('WHERE u.id = $1')) {
      return { rows: data.users.filter(user => user.id === values[0]).map(user => ({ ...user, company_name: data.companies.find(c => c.id === user.company_id)?.name })) };
    }
    if (text.includes('org.company_memberships') && !schemaAvailable) throw Object.assign(new Error('relation org.company_memberships does not exist'), { code: '42P01' });
    if (text.includes('INSERT INTO org.companies')) {
      const company = { id: String(78 + data.companies.length - 1), name: values[0], is_active: true };
      data.companies.push(company); return { rows: [company], rowCount: 1 };
    }
    if (text.startsWith('DELETE FROM org.company_modules')) {
      data.modules = data.modules.filter(row => row.company_id !== values[0]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.company_modules')) {
      for (const module_key of values[1]) data.modules.push({ company_id: values[0], module_key });
      return { rows: [], rowCount: values[1].length };
    }
    if (text.includes('org.company_feature_settings') && !featureSchemaAvailable) {
      throw Object.assign(new Error('relation org.company_feature_settings does not exist'), { code: '42P01' });
    }
    if (text.includes('INSERT INTO org.company_feature_settings')) {
      const existing = data.featureSettings.find(row => row.company_id === values[0]);
      if (existing && text.includes('ON CONFLICT')) existing.enabled_features = [...values[1]];
      else data.featureSettings.push({ company_id: values[0], enabled_features: [...values[1]] });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.departments')) {
      const department = { id: String(data.departments.length + 100), company_id: values[0], name: values[1], parent_id: values[2] ?? null, manager_id: null };
      data.departments.push(department); bumpOrg(data, values[0]); return { rows: [department], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.company_memberships')) {
      if (failMembership) throw new Error('injected membership failure');
      const membership = { company_id: values[0], user_id: values[1], department_id: values[2] ?? null, position_id: values[3] ?? null, status: 'active' };
      data.memberships.push(membership); bumpOrg(data, values[0]); return { rows: [membership], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.permissions')) return { rows: [], rowCount: values[0].length };
    if (text.includes('INSERT INTO org.roles')) {
      const role = { id: String(data.roles.length + 1), company_id: values[0], name: values[1] ?? 'company_creator', is_system: text.includes('true'), scope: values[2] ?? 'all' };
      data.roles.push(role); return { rows: [role], rowCount: 1 };
    }
    if (text.startsWith('DELETE FROM org.role_permissions')) {
      data.permissions = data.permissions.filter(p => p.role_id !== values[0]); return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.role_permissions')) {
      for (const code of values[1]) data.permissions.push({ role_id: values[0], code });
      return { rows: [], rowCount: values[1].length };
    }
    if (text.startsWith('DELETE FROM org.user_roles ur USING')) {
      data.grants = data.grants.filter(g => !(g.user_id === values[1] && data.roles.some(r => r.id === g.role_id && r.company_id === values[0])));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.user_roles')) {
      data.grants.push({ user_id: values[0], role_id: values[1] }); return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.company_events') || text.includes('INSERT INTO org.role_change_events')) {
      if (failSettingsAudit && text.includes('company.settings.updated')) throw new Error('injected settings audit failure');
      data.events.push(values); return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT id FROM org.companies') && text.endsWith('FOR UPDATE')) {
      return { rows: data.companies.filter(c => c.id === values[0] && c.is_active) };
    }
    if (text.startsWith('SELECT r.id, r.name')) {
      return { rows: data.roles.filter(r => r.company_id === values[0]).map(r => ({ ...r,
        permissions: data.permissions.filter(p => p.role_id === r.id).map(p => p.code) })) };
    }
    if (text.startsWith('SELECT m.user_id, u.name')) {
      return { rows: data.memberships.filter(m => m.company_id === values[0] && m.status === 'active')
        .filter(m => data.users.some(u => u.id === m.user_id && u.account_status === 'active' && u.approval_status === 'approved'))
        .map(m => ({ ...data.users.find(u => u.id === m.user_id), user_id: m.user_id,
          roles: data.roles.filter(r => r.company_id === m.company_id && data.grants.some(g => g.user_id === m.user_id && g.role_id === r.id)).map(r => r.id) })) };
    }
    if (text.startsWith('SELECT DISTINCT p.code')) {
      const roles = data.roles.filter(role => role.company_id === values[1] && data.grants.some(grant => grant.user_id === values[0] && grant.role_id === role.id));
      return { rows: roles.flatMap(role => data.permissions.filter(p => p.role_id === role.id).map(p => ({ code: p.code, role: role.name }))) };
    }
    if (text.includes('FROM org.company_modules')) return { rows: data.modules.filter(row => row.company_id === values[0]) };
    if (text.includes('FROM org.company_feature_settings')) return { rows: data.featureSettings.filter(row => row.company_id === values[0]) };
    if (text.includes('SELECT name FROM org.companies')) return { rows: data.companies.filter(row => row.id === values[0]) };
    if (text.includes('FROM org.company_memberships m JOIN org.companies c')) {
      return { rows: data.memberships.filter(m => m.user_id === values[0] && (values.length === 1 || m.company_id === values[1]) && m.status === 'active')
        .filter(m => data.companies.some(c => c.id === m.company_id && c.is_active)).map(m => ({ ...m, name: data.companies.find(c => c.id === m.company_id).name })) };
    }
    if (text.includes('AS members') && text.includes('org.company_memberships')) return { rows: [{ members: data.memberships.filter(m => m.company_id === values[0] && m.status === 'active').length, projects: 0, tasks: 0, documents: 0 }] };
    if (text.includes('FROM org.company_memberships m JOIN auth.users u')) {
      return { rows: data.memberships.filter(m => m.company_id === values[values.length - 1] && (values.length === 1 || m.user_id === values[0]) && m.status === 'active')
        .filter(m => !text.includes("AND u.account_status = 'active'") || data.users.some(u => u.id === m.user_id && u.account_status === 'active' && u.approval_status === 'approved'))
        .map(m => ({ ...data.users.find(user => user.id === m.user_id), ...m, id: m.user_id, account_status: m.status, position_name: null, roles: data.roles.filter(r => r.company_id === m.company_id && data.grants.some(g => g.user_id === m.user_id && g.role_id === r.id)).map(r => r.name) })) };
    }
    if (text.startsWith('UPDATE org.company_memberships')) {
      const membership = data.memberships.find(m => m.user_id === values[0] && m.company_id === values[1]);
      if (membership) {
        membership.department_id = values[2];
        if (text.includes('position_id = $4')) membership.position_id = values[3];
        bumpOrg(data, values[1]);
      }
      return { rows: [], rowCount: membership ? 1 : 0 };
    }
    if (text.includes('FROM org.departments')) return { rows: data.departments.filter(d => d.company_id === values[values.length - 1] && (values.length === 1 || d.id === values[0])) };
    if (text.startsWith('UPDATE org.departments')) {
      const department = data.departments.find(d => d.id === values[0] && d.company_id === values[1]);
      if (department) {
        department.manager_id = values[2];
        if (text.includes('name = $4')) department.name = values[3];
        bumpOrg(data, values[1]);
      }
      return { rows: [], rowCount: department ? 1 : 0 };
    }
    if (text.includes('INSERT INTO project.projects')) {
      const project = { id: String(data.projects.length + 200), company_id: values[0], name: values[1] };
      data.projects.push(project); return { rows: [project], rowCount: 1 };
    }
    if (text.includes('FROM project.projects')) return { rows: data.projects.filter(p => p.company_id === values[values.length - 1] && (values.length === 1 || p.id === values[0])) };
    if (text.includes('INSERT INTO project.tasks')) { data.tasks.push(values); return { rows: [{ id: '300' }], rowCount: 1 }; }
    if (text.includes('accounting.request_replays')) {
      const replay = data.replays.find(r => r.scope.every((value, i) => value === values[i]));
      if (text.startsWith('INSERT')) {
        if (!replay) data.replays.push({ scope: values.slice(0,4), payload: JSON.parse(values[4]), response: null });
        return { rows: [], rowCount: replay ? 0 : 1 };
      }
      if (text.startsWith('SELECT')) return { rows: replay ? [{ response: replay.response, matches: JSON.stringify(replay.payload) === JSON.stringify(JSON.parse(values[4])) }] : [] };
      if (text.startsWith('UPDATE')) { replay.response = JSON.parse(values[4]); return { rows: [], rowCount: 1 }; }
    }
    if (text.includes('INSERT INTO accounting.dues_charges')) {
      const charge = { id: String(301 + data.duesCharges.length), company_id: values[0], target_user_id: values[1], amount: values[2] };
      data.duesCharges.push(charge); return { rows: [charge], rowCount: 1 };
    }
    if (text.includes('INSERT INTO org.approval_requests')) return { rows: [{ id: '301' }], rowCount: 1 };
    if (text.includes('FROM org.approval_requests ar')) return { rows: [] };
    // 이 fixture가 주장하지 않는 대시보드/옵션 읽기만 빈 결과로 둔다. 쓰기와 auth는 절대 폴백하지 않는다.
    if (text.startsWith('SELECT') && !text.includes('auth.') && !text.includes('company_memberships')) return { rows: [] };
    throw new Error('Unexpected native company fixture SQL: ' + text);
  }
  pgPool.query = async (sql, values) => execute(state, sql, values);
  pgPool.connect = async () => {
    let pending;
    return { async query(sql, values) {
      if (sql === 'BEGIN') { pending = structuredClone(state); return { rows: [] }; }
      if (sql === 'COMMIT') { state = pending; return { rows: [] }; }
      if (sql === 'ROLLBACK') { pending = undefined; return { rows: [] }; }
      return execute(pending, sql, values);
    }, release() {} };
  };
  return { get users() { return state.users; }, queries, get state() { return state; },
    set failMembership(value) { failMembership = value; }, set schemaAvailable(value) { schemaAvailable = value; },
    set featureSchemaAvailable(value) { featureSchemaAvailable = value; },
    set failSettingsAudit(value) { failSettingsAudit = value; },
    async close() { pgPool.query = originalQuery; pgPool.connect = originalConnect; await pgPool.end(); } };
}
