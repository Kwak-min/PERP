import assert from "node:assert/strict";
import test, { after } from "node:test";

// perp_db(PostgreSQL) 는 SSH 터널 너머 원격이다. 아무도 듣지 않는 포트를 가리켜
// "DB 불통" 상황을 결정론적으로 재현한다. env.js 가 import 시점에 읽으므로 먼저 설정.
process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
process.env.PG_CONNECTION_TIMEOUT_MS = "1500";

const { startTestServer } = await import("./http.js");

// 풀은 파일 전체에서 한 번만 닫는다.
after(async () => {
  const { closePgPool } = await import("../src/config/pg.js");
  await closePgPool();
});

test("perp_db 가 불통이면 로그인은 503 SERVICE_UNAVAILABLE 과 조치 안내를 준다", async (t) => {
  const server = await startTestServer();
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.baseUrl}/pg/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@naver.com", password: "aaaaaaaa" }),
  });
  const body = await response.json();

  assert.equal(
    response.status,
    503,
    `DB 불통은 503 이어야 한다 (실제 ${response.status}, body=${JSON.stringify(body)})`,
  );
  assert.equal(body.error.code, "SERVICE_UNAVAILABLE");
  assert.match(body.error.message, /perp_db/);
});

test("perp_db 가 불통이어도 레거시 SQLite 로그인은 그대로 동작한다", async (t) => {
  const server = await startTestServer();
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.baseUrl}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "legacy@example.com", password: "aaaaaaaa", name: "레거시" }),
  });
  assert.ok(response.status < 500, `레거시 경로는 5xx 가 아니어야 한다 (실제 ${response.status})`);
});
