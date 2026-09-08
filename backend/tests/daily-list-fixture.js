import { DatabaseSync } from 'node:sqlite';
import { installCompanyFixture } from './pg-company-fixture.js';

// 실제 도메인 SQL을 메모리 SQLite에서 실행한다. PG 드라이버/타입 검증은 아니다.
export async function installDailyListFixture() {
  const identity = await installCompanyFixture();
  const { pgPool } = await import('../src/config/pg.js');
  const identityQuery = pgPool.query;
  const sql = new DatabaseSync(':memory:');
  sql.exec(`ATTACH DATABASE ':memory:' AS accounting;
    CREATE TABLE accounting.budgets (id INTEGER PRIMARY KEY, company_id TEXT, name TEXT,
      amount NUMERIC, spent NUMERIC, status TEXT);
    ATTACH DATABASE ':memory:' AS org; ATTACH DATABASE ':memory:' AS project;
    CREATE TABLE org.company_memberships (company_id TEXT, status TEXT);
    INSERT INTO org.company_memberships VALUES ('77','active');
    CREATE TABLE project.projects (id INTEGER PRIMARY KEY, company_id TEXT);
    INSERT INTO project.projects VALUES (1,'77'),(2,'77'),(3,'88');
    CREATE TABLE project.assignments (project_id INTEGER);
    INSERT INTO project.assignments VALUES (1),(2);
    CREATE TABLE project.tasks (project_id INTEGER, status TEXT);
    INSERT INTO project.tasks VALUES (1,'todo'),(1,'todo'),(1,'todo'),(1,'in_progress'),
      (2,'in_progress'),(2,'done'),(2,'blocked'),(2,'cancelled'),(3,'todo');
    CREATE TABLE project.documents (project_id INTEGER);`);
  identity.state.permissions.push(...['budget.read', 'budget.write', 'member.read', 'project.read', 'document.read'].map(code => ({ role_id: '1', code })));
  identity.state.modules.push({ company_id: '77', module_key: 'finance' });
  pgPool.query = async (text, values = []) => {
    if (!text.includes('accounting.budgets') && !text.includes('AS members')) return identityQuery.call(pgPool, text, values);
    const params = [];
    const query = text.replace(/UPDATE accounting.budgets t SET/, 'UPDATE accounting.budgets AS t SET')
      .replace(/\$(\d+)/g, (_, n) => { params.push(values[Number(n) - 1]); return '?'; });
    const statement = sql.prepare(query);
    if (/^\s*(UPDATE|DELETE)/.test(query)) return { rows: [], rowCount: Number(statement.run(...params).changes) };
    const rows = statement.all(...params);
    return { rows, rowCount: rows.length };
  };
  return {
    identity,
    seed() {
      sql.exec('DELETE FROM accounting.budgets');
      const insert = sql.prepare('INSERT INTO accounting.budgets VALUES (?, ?, ?, ?, ?, ?)');
      for (let id = 1; id <= 25; id++) insert.run(id, '77', `${id === 25 ? '제외' : '대상'}-${String(id).padStart(2, '0')}`, 1000 + id, 0, id % 2 ? 'active' : 'draft');
      insert.run(99, '88', '외부-비공개', 9999, 0, 'active');
    },
    snapshot() { return sql.prepare('SELECT * FROM accounting.budgets ORDER BY id').all().map(row => ({ ...row })); },
    async close() { sql.close(); await identity.close(); },
  };
}
