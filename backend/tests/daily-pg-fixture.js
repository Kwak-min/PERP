import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { installCompanyFixture } from './pg-company-fixture.js';

// 신원 경계만 기존 fixture를 사용한다. 업무 SQL/제약/트랜잭션은 실제 PostgreSQL WASM 엔진에서 실행한다.
export async function installDailyPgFixture({ migration = true } = {}) {
  const identity = await installCompanyFixture();
  const { pgPool } = await import('../src/config/pg.js');
  const identityQuery = pgPool.query;
  const engine = new PGlite();
  await engine.exec(`CREATE SCHEMA common; CREATE SCHEMA org; CREATE SCHEMA auth; CREATE SCHEMA project; CREATE SCHEMA calendar; CREATE SCHEMA asset; CREATE SCHEMA notice; CREATE SCHEMA accounting;
    CREATE TYPE common.visibility AS ENUM ('private', 'company', 'department', 'team');
    CREATE TABLE org.companies (id bigint PRIMARY KEY); INSERT INTO org.companies VALUES (77), (88);
    CREATE TABLE auth.users (id bigint PRIMARY KEY, name text, account_status text DEFAULT 'active', approval_status text DEFAULT 'approved');
    INSERT INTO auth.users(id,name) VALUES (101,'PG QA'), (102,'Same company'), (103,'Foreign');
    CREATE TABLE org.departments(id bigint PRIMARY KEY); CREATE TABLE org.teams(id bigint PRIMARY KEY);
    CREATE TABLE project.milestones(id bigint PRIMARY KEY); CREATE TABLE project.assignments(id bigint PRIMARY KEY);
    CREATE TABLE org.company_memberships(company_id bigint, user_id bigint, status text DEFAULT 'active', PRIMARY KEY(company_id,user_id));
    INSERT INTO org.company_memberships(company_id,user_id) VALUES (77,101), (77,102), (88,103);`);
  const schema = await readFile(new URL('../../db/perp_schema.sql', import.meta.url), 'utf8');
  const additions = await readFile(new URL('../../db/perp_additions_v3.sql', import.meta.url), 'utf8');
  const finance = await readFile(new URL('../../db/perp_additions_v8_daily_finance.sql', import.meta.url), 'utf8');
  for (const [source, table] of [[schema, 'project.projects'], [schema, 'project.project_members'], [schema, 'calendar.events'], [additions, 'project.tasks'], [additions, 'asset.assets'], [additions, 'asset.history'], [additions, 'notice.notifications'], [finance, 'accounting.request_replays']]) {
    const start = source.indexOf(`CREATE TABLE ${source === schema ? '' : 'IF NOT EXISTS '}${table} (`);
    await engine.exec(source.slice(start, source.indexOf('\n);', start) + 3));
  }
  if (migration) await engine.exec(await readFile(new URL('../../db/perp_additions_v9_daily_corrections.sql', import.meta.url), 'utf8'));
  identity.state.permissions.push(...['project.read','project.write','task.write','event.read','event.write','asset.read','asset.write','member.read','notification.read'].map(code => ({ role_id: '1', code })));
  identity.state.modules.push(...['projects','calendar','assets'].map(module_key => ({ company_id: '77', module_key })));
  identity.state.memberships.push({ company_id: '77', user_id: '102', status: 'active' });
  const execute = async (text, params = []) => {
    const result = await engine.query(text, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  pgPool.query = (text, values) => /project\.|calendar\.|asset\.|notice\.|accounting.request_replays|org.daily_correction_events/.test(text) && !text.includes('AS members')
    ? execute(text, values) : identityQuery(text, values);
  // 트랜잭션은 풀 클라이언트처럼 단독 소유한다. 동시 HTTP 요청도 BEGIN을 섞지 않는다.
  let tail = Promise.resolve();
  pgPool.connect = async () => {
    const previous = tail; let unlock;
    tail = new Promise(resolve => { unlock = resolve; }); await previous;
    return { query: execute, release() { unlock(); } };
  };
  return { engine, identity, async close() { await engine.close(); await identity.close(); } };
}
