import { DatabaseSync } from 'node:sqlite';
import { installCompanyFixture } from './pg-company-fixture.js';

// 실제 도메인 SQL을 메모리 SQLite에서 실행한다. PG 드라이버/타입 검증은 아니다.
export async function installDailyListFixture() {
  const identity = await installCompanyFixture();
  const { pgPool } = await import('../src/config/pg.js');
  const identityQuery = pgPool.query, identityConnect = pgPool.connect;
  const sql = new DatabaseSync(':memory:');
  sql.exec(`ATTACH DATABASE ':memory:' AS accounting;
    CREATE TABLE accounting.budgets (id INTEGER PRIMARY KEY, company_id TEXT, name TEXT,
      amount NUMERIC CHECK (amount > 0), spent NUMERIC DEFAULT 0, status TEXT,
      version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE accounting.record_events (id INTEGER PRIMARY KEY, company_id TEXT, actor_id TEXT,
      resource TEXT, resource_id TEXT, before_data TEXT, after_data TEXT, request_id TEXT);
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
  const domainQuery = text => /accounting\.(budgets|record_events)|AS members/.test(text);
  function execute(text, values = []) {
    const params = [];
    const query = text.replace(/UPDATE accounting.budgets t SET/, 'UPDATE accounting.budgets AS t SET')
      .replace(/ FOR UPDATE|::jsonb/g, '')
      .replace(/\$(\d+)/g, (_, n) => { params.push(values[Number(n) - 1]); return '?'; });
    const statement = sql.prepare(query);
    if (statement.columns().length === 0) return { rows: [], rowCount: Number(statement.run(...params).changes) };
    const rows = statement.all(...params);
    return { rows, rowCount: rows.length };
  }
  // 단일 SQLite 연결에서 직접 읽기와 트랜잭션을 직렬화한다. PG 잠금 증거는 별도 native 테스트가 맡는다.
  let tail = Promise.resolve();
  async function lock() { const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous; return release; }
  pgPool.query = async (text, values) => {
    const release = await lock();
    try { return domainQuery(text) ? execute(text, values) : await identityQuery.call(pgPool, text, values); }
    finally { release(); }
  };
  pgPool.connect = async () => {
    const release = await lock();
    const client = await identityConnect.call(pgPool);
    return { async query(text, values) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
        const result = await client.query(text, values);
        sql.exec(text);
        return result;
      }
      return domainQuery(text) ? execute(text, values) : client.query(text, values);
    }, release() { client.release(); release(); } };
  };
  return {
    identity,
    seed() {
      sql.exec('DROP TRIGGER IF EXISTS accounting.fail_list_audit; DELETE FROM accounting.record_events; DELETE FROM accounting.budgets');
      identity.state.replays = [];
      const insert = sql.prepare('INSERT INTO accounting.budgets (id,company_id,name,amount,spent,status) VALUES (?, ?, ?, ?, ?, ?)');
      for (let id = 1; id <= 25; id++) insert.run(id, '77', `${id === 25 ? '제외' : '대상'}-${String(id).padStart(2, '0')}`, 1000 + id, 0, id % 2 ? 'active' : 'draft');
      insert.run(99, '88', '외부-비공개', 9999, 0, 'active');
    },
    snapshot() { return sql.prepare('SELECT * FROM accounting.budgets ORDER BY id').all().map(row => ({ ...row })); },
    events() { return sql.prepare('SELECT * FROM accounting.record_events ORDER BY id').all().map(row => ({ ...row, before_data: JSON.parse(row.before_data), after_data: JSON.parse(row.after_data) })); },
    set failAudit(value) {
      sql.exec('DROP TRIGGER IF EXISTS accounting.fail_list_audit');
      if (value) sql.exec("CREATE TRIGGER accounting.fail_list_audit BEFORE INSERT ON record_events BEGIN SELECT RAISE(ABORT, 'injected list audit failure'); END");
    },
    async close() { sql.close(); await identity.close(); },
  };
}
