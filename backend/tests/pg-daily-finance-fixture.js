import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';

// Embedded PostgreSQL WASM engine, not a remote/native PostgreSQL server.
export async function installFinanceFixture() {
  const db = new PGlite({ extensions: { btree_gist } });
  const schema = new URL('../../db/', import.meta.url);
  for (const name of ['perp_schema.sql', ...[2,3,4,5,6,7].map(n => `perp_additions_v${n}.sql`)]) {
    await db.exec(await readFile(new URL(name, schema), 'utf8'));
  }
  const addition = new URL('perp_additions_v8_daily_finance.sql', schema);
  await db.exec(await readFile(addition, 'utf8'));
  await db.exec(await readFile(addition, 'utf8')); // additive migration must be rerunnable
  for (const name of ['perp_additions_v9_daily_corrections.sql', 'perp_additions_v10_org_audit.sql']) {
    await db.exec(await readFile(new URL(name, schema), 'utf8'));
  }
  await db.exec(`INSERT INTO org.companies (name) VALUES ('Finance fixture'), ('Other fixture');
    INSERT INTO auth.users (company_id, email, name, password_hash, approval_status) VALUES
      (1,'admin@example.invalid','Admin','not-a-secret','approved'),
      (1,'requester@example.invalid','Requester','not-a-secret','approved'),
      (2,'other@example.invalid','Other','not-a-secret','approved');
    INSERT INTO org.company_memberships (company_id,user_id) VALUES (1,1),(1,2),(2,3);
    INSERT INTO org.roles (company_id,name) VALUES (1,'fixture_admin'),(1,'fixture_requester'),(2,'fixture_other');
    INSERT INTO org.user_roles(user_id,role_id) VALUES(1,1),(2,2),(3,3);
    INSERT INTO org.company_modules(company_id,module_key) VALUES(1,'finance'),(1,'assets'),(1,'approvals'),(2,'finance');
    INSERT INTO org.company_feature_settings(company_id,enabled_features) VALUES(1,ARRAY['approvals']), (2,ARRAY['approvals']);
    INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES(1,'100','Cash','asset'),(1,'400','Revenue','revenue'),(2,'400','Other revenue','revenue');`);
  const permissions = [...new Set([...COMPANY_PERMISSIONS, 'menu.configured'])];
  await db.query(`INSERT INTO org.permissions(code,module) SELECT code, split_part(code,'.',1) FROM unnest($1::text[]) code`, [permissions]);
  await db.exec(`INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.id IN(1,3);
    INSERT INTO org.role_permissions(role_id,permission_id) SELECT 2,id FROM org.permissions WHERE code IN('approval.request','menu.approvals','menu.configured');`);
  const tokens = [randomUUID(), randomUUID(), randomUUID()];
  for (let i=0;i<3;i++) await db.query('INSERT INTO auth.sessions(user_id,session_token) VALUES($1,$2)', [i+1,tokens[i]]);
  const { pgPool } = await import('../src/config/pg.js');
  const originalQuery = pgPool.query, originalConnect = pgPool.connect;
  let tail = Promise.resolve(), failWrite = 0, writes = 0;
  async function lock() { const previous = tail; let release; tail = new Promise(r => { release = r; }); await previous; return release; }
  function result(r) { return { ...r, rowCount: r.affectedRows ?? r.rows.length }; }
  async function execute(sql, values) {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) { writes++; if (writes === failWrite) throw new Error('injected write failure'); }
    return result(await db.query(sql, values));
  }
  pgPool.query = async (sql, values) => { const release = await lock(); try { return await execute(sql, values); } finally { release(); } };
  pgPool.connect = async () => { const release = await lock(); return { query: execute, release }; };
  return { db, actor(i=0) { return { token: tokens[i], orgId: i===2?'pg:2':'pg:1' }; },
    inject(n=0) { failWrite=n; writes=0; }, get writes() { return writes; },
    async snapshot() { const tables=['accounting.journal_entries','accounting.journal_lines','asset.assets','asset.history','accounting.dues_charges','accounting.dues_payments','accounting.budgets','accounting.settlements','accounting.record_events','org.approval_requests','org.role_change_events'];
      return Promise.all([...tables.map(async table => (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows),
        db.query('SELECT * FROM accounting.request_replays ORDER BY company_id,actor_id,operation,request_key').then(r=>r.rows)]); },
    async close() { pgPool.query=originalQuery; pgPool.connect=originalConnect; await db.close(); await pgPool.end(); }
  };
}
