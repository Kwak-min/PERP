import pg from "pg";

import { env } from "./env.js";

const { Pool } = pg;

// perp_db (PostgreSQL) 커넥션 풀.
// strangler-fig 데이터 접근 계층: 기존 SQLite(db.js)와 병행 운용.
// DATABASE_URL 이 있으면 우선 사용, 없으면 개별 PG_* 값으로 구성.
const poolConfig = env.pg.connectionString
  ? {
      connectionString: env.pg.connectionString,
      max: env.pg.max,
      idleTimeoutMillis: env.pg.idleTimeoutMillis,
      connectionTimeoutMillis: env.pg.connectionTimeoutMillis,
    }
  : {
      host: env.pg.host,
      port: env.pg.port,
      database: env.pg.database,
      user: env.pg.user,
      password: env.pg.password,
      max: env.pg.max,
      idleTimeoutMillis: env.pg.idleTimeoutMillis,
      connectionTimeoutMillis: env.pg.connectionTimeoutMillis,
    };

export const pgPool = new Pool(poolConfig);

// 유휴 클라이언트 오류가 프로세스를 죽이지 않도록 로깅만.
pgPool.on("error", (err) => {
  console.error("[pg] idle client error", err);
});

/**
 * 파라미터라이즈드 쿼리 헬퍼.
 * @param {string} text - $1, $2 ... 플레이스홀더 사용
 * @param {Array} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function pgQuery(text, params = []) {
  return pgPool.query(text, params);
}

/**
 * 단일 트랜잭션 실행 헬퍼.
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function pgTransaction(fn) {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 풀 종료 (graceful shutdown 용). */
export async function closePgPool() {
  await pgPool.end();
}
