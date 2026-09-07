import { DatabaseSync } from 'node:sqlite';
import { installCompanyFixture } from './pg-company-fixture.js';

// PG 도메인 SQL은 격리 SQLite에서 실행한다. 실제 PG 드라이버/타입 검증은 아니다.
export async function installProjectTaskFixture() {
  const identity = await installCompanyFixture();
  const { pgPool } = await import('../src/config/pg.js');
  const identityQuery = pgPool.query;
  const sql = new DatabaseSync(':memory:');
  sql.exec(`ATTACH DATABASE ':memory:' AS project; ATTACH DATABASE ':memory:' AS auth;
    CREATE TABLE auth.users (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO auth.users VALUES ('101', 'QA');
    CREATE TABLE project.projects (id INTEGER PRIMARY KEY, company_id TEXT, name TEXT, description TEXT, status TEXT, starts_on TEXT, ends_on TEXT, lead_id TEXT);
    CREATE TABLE project.tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), assignee_id TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'todo', due_on TEXT, sort_order INTEGER DEFAULT 0);`);
  identity.state.permissions.push(...['project.read', 'project.write', 'task.write', 'member.read'].map(code => ({ role_id: '1', code })));
  identity.state.modules.push({ company_id: '77', module_key: 'projects' });
  const queries = [];
  pgPool.query = async (text, values = []) => {
    if (!/project\.(projects|tasks)/.test(text) || text.includes('AS members')) return identityQuery.call(pgPool, text, values);
    queries.push({ text, values });
    const parameters = [];
    const translated = text.replace(/UPDATE (project\.\w+) t SET/g, 'UPDATE $1 AS t SET')
      .replace(/\$(\d+)/g, (_, index) => { parameters.push(values[Number(index) - 1]); return '?'; });
    const statement = sql.prepare(translated);
    if (/^\s*(UPDATE|DELETE)/.test(translated)) return { rows: [], rowCount: Number(statement.run(...parameters).changes) };
    const rows = statement.all(...parameters);
    return { rows, rowCount: rows.length };
  };
  return { identity, queries, sql,
    project(name, company = '77') { return String(sql.prepare("INSERT INTO project.projects (company_id, name, status) VALUES (?, ?, 'active') RETURNING id").get(company, name).id); },
    task(projectId, title, status = 'todo') { return String(sql.prepare('INSERT INTO project.tasks (project_id, title, status) VALUES (?, ?, ?) RETURNING id').get(projectId, title, status).id); },
    async close() { sql.close(); await identity.close(); },
  };
}
