import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { startDeadlineServer, evidenceBody } from './deadline-fixture.js';
import { startTestServer, createOwnerOrg } from './http.js';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { networkAudit } from '../../scripts/deadline-isolation-guard.mjs';

const modules = ['analytics', 'tasks', 'projects', 'finance', 'agent', 'approvals'];
export async function analyticsFixture(pgMode, evidenceDirectory) {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  let native, server, pg, database, insert, nativeInfo;
  const http = [], cleanup = {};
  const evidence = evidenceDirectory ?? new URL('../../.omo/evidence/task-24-deadline-erp-redesign/', import.meta.url);
  async function close() {
    if (server) { await server.close(); cleanup.serverClosed = true; }
    if (pg) await pg.closePgPool();
    if (native) { await native.close(); cleanup.nativeClosed = true; cleanup.nativeDirectoryRemoved = !existsSync(nativeInfo.directory); }
    if (server?.resource) cleanup.sqlite = server.resource;
    await mkdir(evidence, { recursive: true });
    await writeFile(new URL(pgMode ? 'native-http.json' : 'sqlite-extended-http.json', evidence), JSON.stringify({ nativeInfo, http, cleanup, networkAudit }, null, 2));
  }
  try {
    if (pgMode) {
      process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
      native = await startDailyNativePostgres();
      nativeInfo = (await native.pool.query("SELECT version() AS version,current_setting('data_directory') AS directory,current_setting('port') AS port")).rows[0];
      assert.match(nativeInfo.version, /PostgreSQL 18\./);
      const ddl = await readFile(new URL('../../db/perp_additions_v17_analytics_exports.sql', import.meta.url), 'utf8');
      await native.pool.query(ddl); await native.pool.query(ddl);
      server = await startTestServer(); pg = await import('../src/config/pg.js');
    } else server = await startDeadlineServer();
    database = (await import('../src/config/db.js')).db();
    insert = (await import('../src/models/base.js')).insert;
    const prefix = pgMode ? '/pg' : '';
    async function api(actor, route, method = 'GET', body, expected = 200) {
      const r = await fetch(server.baseUrl + prefix + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const text = await r.text(), isCsv = r.headers.get('content-type')?.startsWith('text/csv');
      const value = isCsv ? text : text ? JSON.parse(text) : null;
      http.push({ actor: actor?.userId, route, method, status: r.status, body: isCsv && value.length > 5000 ? { bytes: Buffer.byteLength(value), row_count: r.headers.get('x-row-count') } : evidenceBody(value) });
      assert.equal(r.status, expected, `${method} ${route}: ${text.slice(0, 1500)}`);
      if (route.startsWith('/analytics') && r.status < 300) assert.equal(r.headers.get('cache-control'), 'private, no-store');
      return value;
    }
    async function company(name) {
      if (!pgMode) return createOwnerOrg(server.baseUrl, modules, ['approvals']);
      const signup = await api(null, '/auth/signup', 'POST', { name, email: `${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
      const actor = { token: signup.token, userId: signup.user.id };
      actor.orgId = (await api(actor, '/companies', 'POST', { name, modules, features: ['approvals'] }, 201)).org_id;
      return actor;
    }
    const owner = await company('ANALYTICS_A'), foreign = await company('ANALYTICS_B');
    const cid = pgMode ? owner.orgId.slice(3) : null;
    const tenant = pgMode ? null : database.prepare('SELECT tenant_id FROM organization WHERE id=?').get(owner.orgId).tenant_id;
    const record = (table, values) => insert(table, { tenant_id: tenant, org_id: owner.orgId, created_by: owner.userId, ...values });
    async function limited(permissions, scope = 'all') {
      const email = `${randomUUID()}@example.invalid`;
      if (pgMode) {
        const member = await api(owner, '/members', 'POST', { name: 'Analytics limited', email, password: 'password-1234' }, 201);
        const role = (await native.pool.query('INSERT INTO org.roles(company_id,name) VALUES($1,$2) RETURNING id', [cid, randomUUID()])).rows[0].id;
        await native.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [role, [...permissions, 'menu.configured']]);
        await native.pool.query('DELETE FROM org.user_roles WHERE user_id=$1', [member.id]);
        await native.pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES($1,$2)', [member.id, role]);
        const login = await api(null, '/auth/login', 'POST', { email, password: 'password-1234' });
        return { token: login.token, userId: member.id, orgId: owner.orgId, role };
      }
      const role = await api(owner, '/settings/roles', 'POST', { name: randomUUID(), scope, permissions }, 201);
      const invite = await api(owner, '/members/invites', 'POST', { email, roles: [role.key] }, 201);
      const signup = await api(null, '/auth/signup', 'POST', { name: 'Analytics limited', email, password: 'password-1234', invitation_token: invite.token }, 201);
      return { token: signup.access_token, userId: signup.user.id, orgId: owner.orgId, role: role.key };
    }
    async function grants(actor, permissions) {
      if (pgMode) {
        await native.pool.query('DELETE FROM org.role_permissions WHERE role_id=$1', [actor.role]);
        await native.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [actor.role, [...permissions, 'menu.configured']]);
      } else database.prepare('UPDATE company_role SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions), actor.role);
    }
    let project, expense, revenue, cash;
    if (pgMode) {
      project = (await native.pool.query("INSERT INTO project.projects(company_id,name) VALUES($1,'Analytics project') RETURNING id", [cid])).rows[0].id;
      const accounts = (await native.pool.query("INSERT INTO accounting.accounts(company_id,code,name,account_type) SELECT $1,x,x,x FROM unnest(ARRAY['expense','revenue','asset']) x RETURNING id,account_type", [cid])).rows;
      expense = accounts.find(a => a.account_type === 'expense').id; revenue = accounts.find(a => a.account_type === 'revenue').id; cash = accounts.find(a => a.account_type === 'asset').id;
    } else project = record('project', { name: 'Analytics project' }).id;
    async function task(created, status = 'done', due = null, actor = owner) {
      if (pgMode) return (await native.pool.query('INSERT INTO project.tasks(project_id,assignee_id,title,status,due_on,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text', [project, actor.userId, 'Period task', status, due, created])).rows[0].id;
      return record('task', { title: 'Period task', project_id: project, assignee_id: actor.userId, status, due_at: due, created_at: created }).id;
    }
    async function budget(amount = '100.00', active = true) {
      if (pgMode) return (await native.pool.query('INSERT INTO accounting.budgets(company_id,name,amount,spent,status) VALUES($1,$2,$3,999999,$4) RETURNING id::text', [cid, 'Analytics budget', amount, active ? 'active' : 'closed'])).rows[0].id;
      const { decimalMinor } = await import('../src/services/analytics-contract.service.js');
      return record('budget', { name: 'Analytics budget', amount_minor: Number(decimalMinor(amount)), status: active ? 'approved' : 'closed' }).id;
    }
    async function entry(date, amount, kind = 'expense', posted = true, budgetId = null, currency = 'KRW') {
      if (pgMode) {
        const client = await native.pool.connect();
        try {
          await client.query('BEGIN');
          const id = (await client.query('INSERT INTO accounting.journal_entries(company_id,entry_date,created_by,budget_id) VALUES($1,$2,$3,$4) RETURNING id::text', [cid, date, owner.userId, budgetId])).rows[0].id;
          const chosen = kind === 'income' ? revenue : expense;
          await client.query(`INSERT INTO accounting.journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,$3,$4),($1,$5,$4,$3)`, [id, chosen, kind === 'income' ? '0.00' : amount, kind === 'income' ? amount : '0.00', cash]);
          if (posted) await client.query('UPDATE accounting.journal_entries SET posted=true WHERE id=$1', [id]);
          await client.query('COMMIT'); return id;
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      }
      const { decimalMinor } = await import('../src/services/analytics-contract.service.js');
      return record('transaction_record', { occurred_on: date, amount_minor: Number(decimalMinor(amount)), kind, status: posted ? 'confirmed' : 'draft', budget_id: budgetId, currency }).id;
    }
    async function approval(actor, created, status = 'draft', decided = null, assigned = owner) {
      if (pgMode) return (await native.pool.query(`INSERT INTO org.approval_requests(company_id,request_type,requester_id,status,created_at,decided_at)
        VALUES($1,'generic',$2,$3,$4,$5) RETURNING id::text`, [cid, actor.userId, status, created, decided])).rows[0].id;
      const id = record('approval', { title: 'Analytics private request', requester_id: actor.userId, status, created_at: created }).id;
      if (status !== 'draft') record('approval_step', { approval_id: id, ordinal: 0, approver_id: assigned.userId, status: status === 'pending' ? 'pending' : status, decided_at: decided });
      return id;
    }
    async function feature(enabled) {
      if (pgMode) await native.pool.query("UPDATE org.company_feature_settings SET enabled_features=$2 WHERE company_id=$1", [cid, enabled ? ['approvals'] : []]);
      else database.prepare('UPDATE organization SET enabled_features=? WHERE id=?').run(enabled ? 'approvals' : '', owner.orgId);
    }
    async function moduleEnabled(key, enabled) {
      if (pgMode) {
        if (enabled) await native.pool.query('INSERT INTO org.company_modules(company_id,module_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [cid, key]);
        else await native.pool.query('DELETE FROM org.company_modules WHERE company_id=$1 AND module_key=$2', [cid, key]);
      } else {
        const org = database.prepare('SELECT modules FROM organization WHERE id=?').get(owner.orgId), set = new Set(org.modules.split(','));
        if (enabled) set.add(key); else set.delete(key);
        database.prepare('UPDATE organization SET modules=? WHERE id=?').run([...set].join(','), owner.orgId);
      }
    }
    async function bulkTasks(count) {
      if (pgMode) await native.pool.query(`INSERT INTO project.tasks(project_id,title,status,created_at) SELECT $1,'Export limit','done','2030-01-01T00:00:00Z' FROM generate_series(1,$2)`, [project, count]);
      else {
        const statement = database.prepare("INSERT INTO task(id,tenant_id,org_id,created_at,updated_at,title,status) VALUES(?,?,?,'2030-01-01T00:00:00Z','2030-01-01T00:00:00Z','Export limit','done')");
        database.exec('BEGIN');
        try { for (let i = 0; i < count; i++) statement.run(randomUUID(), tenant, owner.orgId); database.exec('COMMIT'); }
        catch (error) { database.exec('ROLLBACK'); throw error; }
      }
    }
    async function trace(work) {
      const target = pgMode ? pg.pgPool : database, method = pgMode ? 'query' : 'prepare', original = target[method], queries = [];
      target[method] = function (...args) { queries.push(String(args[0])); return original.apply(this, args); };
      try { const value = await work(); return { value, queries }; }
      finally { target[method] = original; }
    }
    return { pgMode, baseUrl: server.baseUrl, resource: server.resource, api, owner, foreign, cid, tenant, record, database, native, limited, grants, task, budget, entry, approval, feature, moduleEnabled, bulkTasks, trace, close };
  } catch (error) { await close(); throw error; }
}
