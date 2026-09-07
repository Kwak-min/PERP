import { randomUUID } from 'node:crypto';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';

// 실제 HTTP/인증/권한/서비스를 실행하는 SQL 경계 fixture. PostgreSQL 엔진 검증을 가장하지 않는다.
export async function installRoleFixture() {
  const { pgPool } = await import('../src/config/pg.js');
  const originalQuery = pgPool.query, originalConnect = pgPool.connect;
  let state = {
    companies: [{ id: '77', name: '역할 QA', is_active: true }, { id: '88', name: '외부 QA', is_active: true }],
    users: ['101', '102', '103'].map(id => ({ id, email: `${id}@example.invalid`, name: `사용자 ${id}`, company_id: '77', account_status: 'active', approval_status: 'approved', is_admin: true })),
    memberships: [{ user_id: '101', company_id: '77', status: 'active' }, { user_id: '102', company_id: '77', status: 'active' }, { user_id: '103', company_id: '88', status: 'active' }],
    roles: [{ id: '1', company_id: '77', name: 'fixture_admin', is_system: true, scope: 'all', permissions: [...COMPANY_PERMISSIONS, 'menu.configured'] },
      { id: '2', company_id: '88', name: 'fixture_admin', is_system: true, scope: 'all', permissions: [...COMPANY_PERMISSIONS, 'menu.configured'] }],
    grants: [{ user_id: '101', role_id: '1', workspace_id: null }, { user_id: '103', role_id: '2', workspace_id: null }],
    modules: ['projects', 'tasks', 'approvals'], features: ['approvals'],
    approvals: [{ id: '501', company_id: '77', status: 'pending' }, { id: '502', company_id: '88', status: 'pending' }],
    sessions: ['101', '102', '103'].map(user_id => ({ user_id, token: randomUUID(), id: randomUUID(), login_at: new Date().toISOString() })), events: [],
  };
  const queries = []; let failAudit = false;
  function execute(data, sql, values = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); queries.push({ text, values });
    const rows = values => ({ rows: values, rowCount: values.length });
    if (text.includes('FROM auth.sessions s')) {
      const session = data.sessions.find(row => row.token === values[0]);
      return rows(session ? [{ ...data.users.find(user => user.id === session.user_id), session_id: session.id, login_at: session.login_at }] : []);
    }
    if (text.includes('FROM org.company_memberships m JOIN org.companies c')) return rows(data.memberships.filter(m => m.user_id === values[0] && (!values[1] || m.company_id === values[1]) && m.status === 'active').map(m => ({ ...m, name: data.companies.find(c => c.id === m.company_id)?.name })));
    if (text.startsWith('SELECT DISTINCT p.code')) {
      return rows(data.roles.filter(role => role.company_id === values[1] && !role.deleted_at && data.grants.some(g => g.user_id === values[0] && g.role_id === role.id && g.workspace_id === null))
        .flatMap(role => role.permissions.map(code => ({ code, role: role.name }))));
    }
    if (text.includes('FROM org.company_modules')) return rows(data.modules.map(module_key => ({ module_key })));
    if (text.includes('FROM org.company_feature_settings')) return rows([{ enabled_features: data.features }]);
    if (text.includes('FROM org.departments') || text.includes('FROM org.positions')) return rows([]);
    if (text.includes('FROM org.companies') && text.endsWith('FOR UPDATE')) return rows(data.companies.filter(c => c.id === values[0] && c.is_active));
    if (text.startsWith('SELECT r.id, r.name')) return rows(data.roles.filter(role => role.company_id === values[0] && !role.deleted_at));
    if (text.startsWith('SELECT m.user_id, u.name')) return rows(data.memberships.filter(m => m.company_id === values[0] && m.status === 'active').map(m => ({ ...data.users.find(u => u.id === m.user_id), user_id: m.user_id,
      roles: data.grants.filter(g => g.user_id === m.user_id && g.workspace_id === null && data.roles.some(r => r.id === g.role_id && r.company_id === m.company_id && !r.deleted_at)).map(g => g.role_id) })));
    if (text.startsWith('INSERT INTO org.roles')) {
      if (data.roles.some(r => r.company_id === values[0] && r.name === values[1])) throw Object.assign(new Error('duplicate role name'), { code: '23505' });
      const role = { id: String(data.roles.length + 10), company_id: values[0], name: values[1], is_system: text.includes('true'), scope: values[2], permissions: [] };
      data.roles.push(role); return rows([role]);
    }
    if (text.startsWith('INSERT INTO org.permissions')) return rows([]);
    if (text.startsWith('DELETE FROM org.role_permissions')) { data.roles.find(r => r.id === values[0]).permissions = []; return rows([]); }
    if (text.startsWith('INSERT INTO org.role_permissions')) { data.roles.find(r => r.id === values[0]).permissions = [...values[1]]; return rows([]); }
    if (text.startsWith('UPDATE org.roles')) {
      const role = data.roles.find(r => r.id === values[0] && r.company_id === values[1]);
      if (text.includes('deleted_at = now()')) { role.deleted_at = new Date().toISOString(); if (text.includes("name = '_perp_deleted_role_'")) role.name = `_perp_deleted_role_${role.id}`; }
      else { role.name = values[2]; role.scope = values[3]; }
      return rows([role]);
    }
    if (text.startsWith('DELETE FROM org.user_roles ur USING')) {
      data.grants = data.grants.filter(g => !(g.user_id === values[1] && g.workspace_id === null && data.roles.some(r => r.id === g.role_id && r.company_id === values[0]))); return rows([]);
    }
    if (text.startsWith('DELETE FROM org.user_roles WHERE')) { data.grants = data.grants.filter(g => g.role_id !== values[0]); return rows([]); }
    if (text.startsWith('INSERT INTO org.user_roles')) { data.grants.push({ user_id: values[0], role_id: values[1], workspace_id: null }); return rows([]); }
    if (text.startsWith('INSERT INTO org.role_change_events')) {
      if (failAudit) throw new Error('injected audit failure');
      data.events.push(values); return rows([]);
    }
    if (text.includes('FROM org.approval_requests') && text.endsWith('FOR UPDATE')) return rows(data.approvals.filter(a => a.id === values[0] && a.company_id === values[1]));
    if (text.startsWith('UPDATE org.approval_requests')) { const item = data.approvals.find(a => a.id === values[0] && a.company_id === values[1]); item.status = values[2]; item.decided_by = values[3]; return rows([item]); }
    if (text.startsWith('SELECT') && text.includes('FROM project.tasks t')) return rows([]);
    if (text.startsWith('SELECT') && text.includes('FROM project.projects')) return rows([]);
    throw new Error('Unexpected role fixture SQL: ' + text);
  }
  pgPool.query = async (sql, values) => execute(state, sql, values);
  // fixture 트랜잭션도 직렬화하여 동시 요청에서 lost update를 허용하지 않는다.
  let tail = Promise.resolve();
  pgPool.connect = async () => {
    const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous;
    let pending;
    return { async query(sql, values) {
      if (sql === 'BEGIN') { pending = structuredClone(state); return { rows: [] }; }
      if (sql === 'COMMIT') { state = pending; return { rows: [] }; }
      if (sql === 'ROLLBACK') { pending = undefined; return { rows: [] }; }
      return execute(pending, sql, values);
    }, release() { unlock(); } };
  };
  return { get state() { return state; }, queries, set failAudit(value) { failAudit = value; },
    actor(userId = '101', companyId = '77') { return { token: state.sessions.find(s => s.user_id === userId).token, orgId: `pg:${companyId}` }; },
    async close() { pgPool.query = originalQuery; pgPool.connect = originalConnect; await pgPool.end(); } };
}
