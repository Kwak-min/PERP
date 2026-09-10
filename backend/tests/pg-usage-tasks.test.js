import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { api, startTestServer } from './http.js';
import { installCompanyFixture } from './pg-company-fixture.js';

process.env.DATABASE_URL = '';
process.env.PG_HOST = '127.0.0.1';
process.env.PG_PORT = '1';

test('usage counts company task rows including cancelled, never project assignments', async () => {
  const server = await startTestServer();
  const fixture = await installCompanyFixture();
  fixture.state.permissions.push(...['member.read', 'project.read', 'document.read'].map(code => ({ role_id: '1', code })));
  const { pgPool } = await import('../src/config/pg.js');
  const identityQuery = pgPool.query;
  const sql = new DatabaseSync(':memory:');
  try {
    // Given: 회사77 배정2/업무8(취소1 포함), 다른 회사88 업무3.
    sql.exec(`ATTACH DATABASE ':memory:' AS org; ATTACH DATABASE ':memory:' AS project;
      ATTACH DATABASE ':memory:' AS workspace;
      CREATE TABLE org.company_memberships (company_id TEXT, status TEXT);
      INSERT INTO org.company_memberships VALUES ('77','active'),('88','active');
      CREATE TABLE project.projects (id INTEGER PRIMARY KEY, company_id TEXT);
      INSERT INTO project.projects VALUES (1,'77'),(2,'77'),(3,'88');
      CREATE TABLE project.assignments (project_id INTEGER);
      INSERT INTO project.assignments VALUES (1),(2),(3);
      CREATE TABLE project.tasks (project_id INTEGER, status TEXT);
      INSERT INTO project.tasks VALUES (1,'todo'),(1,'todo'),(1,'todo'),(1,'in_progress'),
        (2,'in_progress'),(2,'done'),(2,'blocked'),(2,'cancelled'),(3,'todo'),(3,'done'),(3,'cancelled');
      CREATE TABLE project.documents (project_id INTEGER);
      INSERT INTO project.documents VALUES (1),(3);
      CREATE TABLE workspace.document_catalog AS
        SELECT d.project_id AS id,p.company_id,d.project_id,'org' AS visibility,
          NULL AS owner_id,'internal' AS sensitivity,0 AS archived,NULL AS deleted_at,
          '2026-09-10' AS updated_at
        FROM project.documents d JOIN project.projects p ON p.id=d.project_id;
      INSERT INTO workspace.document_catalog VALUES
        (4,'77',NULL,'org',NULL,'internal',0,NULL,'2026-09-10'),
        (5,'88',NULL,'org',NULL,'internal',0,NULL,'2026-09-10'),
        (6,'77',NULL,'private','other-user','internal',0,NULL,'2026-09-10'),
        (7,'77',NULL,'org',NULL,'internal',1,NULL,'2026-09-10'),
        (8,'77',NULL,'org',NULL,'internal',0,'2026-09-10','2026-09-10');`);
    pgPool.query = async (text, values = []) => {
      if (!text.includes('AS members') && !text.includes('FROM workspace.document_catalog')) return identityQuery.call(pgPool, text, values);
      const params = [];
      const query = text.replace(/::text/g, '').replace(/\$(\d+)/g, (_, n) => { params.push(values[Number(n) - 1]); return '?'; });
      return { rows: sql.prepare(query).all(...params) };
    };
    const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.users[0].email, password: 'password-1234' } });
    assert.equal(login.status, 200);
    const session = { token: login.body.token, orgId: 'pg:77' };
    // When: 실제 인증/회사 스코프를 거친 집계 HTTP 조회.
    const result = await api(server.baseUrl, '/pg/usage', session);
    // Then: 업무 총계는 취소를 제외하지 않는 목록 전체 개수와 일치한다.
    assert.equal(result.status, 200);
    // 프로젝트 문서와 회사 공용 문서를 함께 세되 타사·타인 비공개·보관/삭제 문서는 제외한다.
    assert.deepEqual(result.body, { members: 1, projects: 2, tasks: 8, documents: 2 });
    assert.equal((await api(server.baseUrl, '/pg/usage', { ...session, orgId: 'pg:88' })).status, 403);
    console.log('PG_USAGE_COMPANY77 assignments=2 tasks=8 cancelled=1 foreignTasks=3 excluded');
  } finally {
    sql.close();
    await fixture.close();
    await server.close();
  }
});
