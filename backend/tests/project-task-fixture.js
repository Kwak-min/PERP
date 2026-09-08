import { DatabaseSync } from 'node:sqlite';
import { installCompanyFixture } from './pg-company-fixture.js';

// PG 도메인 SQL은 격리 SQLite에서 실행한다. 실제 PG 드라이버/타입 검증은 아니다.
export async function installProjectTaskFixture() {
  const identity = await installCompanyFixture();
  const { pgPool } = await import('../src/config/pg.js');
  const identityQuery = pgPool.query;
  const sql = new DatabaseSync(':memory:');
  sql.exec(`ATTACH DATABASE ':memory:' AS project; ATTACH DATABASE ':memory:' AS auth; ATTACH DATABASE ':memory:' AS org;
    CREATE TABLE org.daily_correction_events (id INTEGER PRIMARY KEY, company_id TEXT, actor_id TEXT, resource_type TEXT, resource_id TEXT, action TEXT, before_data TEXT, after_data TEXT);
    CREATE TABLE auth.users (id TEXT PRIMARY KEY, name TEXT, account_status TEXT DEFAULT 'active', approval_status TEXT DEFAULT 'approved');
    INSERT INTO auth.users(id,name) VALUES ('101', 'QA');
    CREATE TABLE org.company_memberships(company_id TEXT, user_id TEXT, status TEXT DEFAULT 'active'); INSERT INTO org.company_memberships(company_id,user_id) VALUES ('77','101');
    CREATE TABLE project.project_members(project_id INTEGER, user_id TEXT);
    CREATE TABLE project.projects (id INTEGER PRIMARY KEY, company_id TEXT, name TEXT, description TEXT, status TEXT, starts_on TEXT, ends_on TEXT, lead_id TEXT, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE project.tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), assignee_id TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'todo', due_on TEXT, sort_order INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);`);
  identity.state.permissions.push(...['project.read', 'project.write', 'task.write', 'member.read'].map(code => ({ role_id: '1', code })));
  identity.state.modules.push({ company_id: '77', module_key: 'projects' });
  const queries = [];
  pgPool.query = async (text, values = []) => {
    if (!/project\.(projects|tasks)|org.daily_correction_events/.test(text) || text.includes('AS members')) return identityQuery.call(pgPool, text, values);
    queries.push({ text, values });
    const parameters = [];
    const translated = text.replace(/UPDATE (project\.\w+) t SET/g, 'UPDATE $1 AS t SET')
      .replace(/ FOR (UPDATE|SHARE)( OF [\w, ]+)?/g, '').replace(/::jsonb/g, '')
      .replace(/to_char\(([pt]\.\w+), 'YYYY-MM-DD'\)/g, '$1')
      .replace(/RETURNING ([\s\S]*)/g, (_, columns) => 'RETURNING ' + columns.replaceAll('t.', ''))
      .replace(/\$(\d+)/g, (_, index) => { parameters.push(values[Number(index) - 1]); return '?'; });
    const statement = sql.prepare(translated);
    if (/^\s*(UPDATE|DELETE|INSERT)/.test(translated) && !translated.includes('RETURNING')) return { rows: [], rowCount: Number(statement.run(...parameters).changes) };
    const rows = statement.all(...parameters);
    return { rows, rowCount: rows.length };
  };
  pgPool.connect = async () => ({ query: async (text, values) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) { sql.exec(text); return { rows: [] }; }
    return pgPool.query(text, values);
  }, release() {} });
  return { identity, queries, sql,
    project(name, company = '77') { return String(sql.prepare("INSERT INTO project.projects (company_id, name, status) VALUES (?, ?, 'active') RETURNING id").get(company, name).id); },
    task(projectId, title, status = 'todo') { return String(sql.prepare('INSERT INTO project.tasks (project_id, title, status) VALUES (?, ?, ?) RETURNING id').get(projectId, title, status).id); },
    async close() { sql.close(); await identity.close(); },
  };
}
