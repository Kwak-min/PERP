import pg from "pg";

import { env } from "./env.js";
import { ApiError } from "../utils/errors.js";

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
// perp_db 는 SSH 터널 너머 원격 PostgreSQL 이라 "닿지 않음" 이 정상적인 실패 모드다.
// 연결·접속설정 계열만 503 으로 바꿔 원인과 조치를 알린다.
// 질의/제약 위반 등 진짜 서버 결함은 그대로 500 으로 남긴다.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P03",
  "53300",
]);

const CONFIG_ERROR_CODES = new Set(["28P01", "28000", "3D000"]);

/** 연결 불가 오류면 503 ApiError, 아니면 null(원본 오류 유지). */
export function unavailableError(error) {
  const code = error?.code;
  const message = error?.message ?? "";
  if (
    CONNECTION_ERROR_CODES.has(code) ||
    /timeout exceeded when trying to connect|Connection terminated/i.test(message)
  ) {
    return new ApiError(
      "SERVICE_UNAVAILABLE",
      "perp_db(PostgreSQL)에 연결할 수 없습니다. SSH 터널이 열려 있는지와 PG_HOST·PG_PORT 설정을 확인하세요.",
      { reason: "connection", pg_code: code ?? null },
    );
  }
  if (CONFIG_ERROR_CODES.has(code)) {
    return new ApiError(
      "SERVICE_UNAVAILABLE",
      "perp_db(PostgreSQL) 접속 정보가 올바르지 않습니다. PG_USER·PG_PASSWORD·PG_DATABASE 를 확인하세요.",
      { reason: "credentials", pg_code: code },
    );
  }
  return null;
}

export async function pgQuery(text, params = []) {
  try {
    return await pgPool.query(text, params);
  } catch (error) {
    throw unavailableError(error) ?? error;
  }
}

/**
 * 단일 트랜잭션 실행 헬퍼.
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function pgTransaction(fn) {
  let client;
  try {
    client = await pgPool.connect();
  } catch (error) {
    throw unavailableError(error) ?? error;
  }
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
