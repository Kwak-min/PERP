import { DatabaseSync } from 'node:sqlite';
import { installCompanyFixture } from '../../backend/tests/pg-company-fixture.js';

// PG 접속 대신 실제 SQL을 격리 SQLite에서 실행한다. PG 날짜/드라이버 자체 검증은 아니다.
// 캘린더 SELECT/INSERT의 회사 스코프, 기간 조건, LIMIT은 운영 컨트롤러 SQL 그대로 실행한다.
export async function installCalendarFixture() {
  const identity = await installCompanyFixture();
  const { pgPool } = await import('../../backend/src/config/pg.js');
  const identityQuery = pgPool.query;
  const sql = new DatabaseSync(':memory:');
  sql.exec("ATTACH DATABASE ':memory:' AS calendar; CREATE TABLE calendar.events (id INTEGER PRIMARY KEY, company_id TEXT, owner_id TEXT, title TEXT, location TEXT, starts_at TEXT, ends_at TEXT, scope TEXT, version INTEGER NOT NULL DEFAULT 1, cancelled_at TEXT)");
  identity.state.permissions.push(...['event.read', 'event.write', 'member.read', 'menu.calendar'].map(code => ({ role_id: '1', code })));
  identity.state.modules.push({ company_id: '77', module_key: 'calendar' });
  const queries = [];
  pgPool.query = async (text, values = []) => {
    if (!text.includes('calendar.events')) return identityQuery.call(pgPool, text, values);
    queries.push({ text, values });
    const parameters = [];
    const translated = text.replace(/\$(\d+)/g, (_, index) => { parameters.push(values[Number(index) - 1]); return '?'; });
    return { rows: sql.prepare(translated).all(...parameters), rowCount: 1 };
  };
  return { identity, queries,
    seed(event, company = '77') {
      return sql.prepare("INSERT INTO calendar.events (company_id, owner_id, title, location, starts_at, ends_at, scope) VALUES (?, '101', ?, ?, ?, ?, 'company') RETURNING id")
        .get(company, event.title, event.location ?? null, new Date(event.start_at).toISOString(), new Date(event.end_at).toISOString()).id;
    },
    async close() { sql.close(); await identity.close(); },
  };
}
