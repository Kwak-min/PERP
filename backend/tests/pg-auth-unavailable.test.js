import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";

const sockets = new Set();
let startupCount = 0;
// 포트를 닫고 재사용을 기대하지 않는다. 소유한 서버가 실제 pg 클라이언트의
// startup 데이터를 받은 직후 TCP 연결을 끊어 연결 불가 오류를 발생시킨다.
const dependency = net.createServer((socket) => {
  sockets.add(socket);
  let startupBytes = 0;
  socket.once("close", () => {
    sockets.delete(socket);
    if (startupBytes) dependency.emit("unavailable", startupBytes);
  });
  socket.once("data", (data) => {
    startupBytes = data.length;
    startupCount += 1;
    socket.resetAndDestroy();
  });
});
let server;
let db;
let closePgPool;
let databaseRoot;
let dependencyPort;

before(async () => {
  const listening = once(dependency, "listening", { signal: AbortSignal.timeout(10000) });
  dependency.listen(0, "127.0.0.1");
  await listening;
  dependencyPort = dependency.address().port;
  // env.js 가 import 시점에 읽으므로 실제 소유 포트를 먼저 설정한다.
  process.env.DATABASE_URL = "";
  process.env.PG_HOST = "127.0.0.1";
  process.env.PG_PORT = String(dependencyPort);
  // 연결 타이머가 아니라 위의 데이터/close 이벤트가 실패 원인이어야 한다.
  process.env.PG_CONNECTION_TIMEOUT_MS = "0";
  const { startTestServer } = await import("./http.js");
  server = await startTestServer();
  ({ db } = await import("../src/config/db.js"));
  ({ closePgPool } = await import("../src/config/pg.js"));
  databaseRoot = path.dirname(process.env.ORBITFLOW_DATABASE_FILE);
}, { timeout: 10000 });

// HTTP/SQLite와 PG 풀은 파일 전체에서 한 번만 열고 닫는다.
after(async (t) => {
  try {
    if (dependency.listening) {
      const closed = once(dependency, "close");
      const socketClosures = [...sockets].map((socket) => {
        const socketClosed = once(socket, "close");
        socket.destroy();
        return socketClosed;
      });
      dependency.close();
      await Promise.all([closed, ...socketClosures]);
    }
  } finally {
    try {
      await closePgPool?.();
    } finally {
      await server?.close();
    }
  }
  assert.equal(dependency.listening, false);
  assert.equal(sockets.size, 0);
  if (databaseRoot) assert.equal(existsSync(databaseRoot), false);
  t.diagnostic(JSON.stringify({ cleanup: true, dependencyPort, sockets: sockets.size, databaseRoot, temporaryRemoved: !existsSync(databaseRoot) }));
}, { timeout: 10000 });

test("perp_db 가 불통이면 로그인은 503 SERVICE_UNAVAILABLE 과 조치 안내를 준다", { timeout: 10000 }, async (t) => {
  // 같은 자격증명의 레거시 사용자가 있어도 PG 실패를 로그인 성공으로 바꾸면 안 된다.
  const credentials = { email: "unavailable@example.com", password: "aaaaaaaa" };
  const signup = await fetch(`${server.baseUrl}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, name: "레거시" }),
    signal: t.signal,
  });
  assert.equal(signup.status, 201);
  await signup.json();
  const legacyCounts = () => ["app_user", "auth_identity", "session_token", "tenant", "organization", "membership"]
    .map((table) => db().prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
  const beforeCounts = legacyCounts();
  assert.deepEqual(beforeCounts, [1, 0, 1, 0, 0, 0]);

  // 요청 전 구독하며 실제 소켓의 종료와 HTTP 응답을 모두 기다린다.
  const unavailable = once(dependency, "unavailable", { signal: t.signal });
  const [response, [startupBytes]] = await Promise.all([
    fetch(`${server.baseUrl}/pg/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
      signal: t.signal,
    }),
    unavailable,
  ]);
  const body = await response.json();
  assert.ok(startupBytes > 0);
  assert.equal(startupCount, 1);

  assert.equal(
    response.status,
    503,
    `DB 불통은 503 이어야 한다 (실제 ${response.status}, body=${JSON.stringify(body)})`,
  );
  assert.equal(body.error.code, "SERVICE_UNAVAILABLE");
  assert.match(body.error.message, /perp_db/);
  assert.equal(body.error.details.reason, "connection");
  assert.equal(body.error.request_id, response.headers.get("x-request-id"));
  assert.equal(body.token, undefined);
  assert.equal(body.access_token, undefined);
  assert.deepEqual(legacyCounts(), beforeCounts);
  t.diagnostic(JSON.stringify({ route: "/pg/auth/login", status: response.status, error: body.error, startupBytes, legacyCounts: legacyCounts() }));
});

test("perp_db 가 불통이어도 레거시 SQLite 로그인은 그대로 동작한다", { timeout: 10000 }, async (t) => {
  const connectionsBefore = startupCount;

  const response = await fetch(`${server.baseUrl}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "legacy@example.com", password: "aaaaaaaa", name: "레거시" }),
    signal: t.signal,
  });
  assert.ok(response.status < 500, `레거시 경로는 5xx 가 아니어야 한다 (실제 ${response.status})`);
  assert.equal(response.status, 201);
  const signup = await response.json();
  assert.equal(signup.org_id, null);
  const login = await fetch(`${server.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "legacy@example.com", password: "aaaaaaaa" }),
    signal: t.signal,
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.equal(body.user.id, signup.user.id);
  assert.ok(body.access_token);
  assert.equal(db().prepare("SELECT count(*) AS count FROM membership").get().count, 0);
  assert.equal(startupCount, connectionsBefore);
  t.diagnostic(JSON.stringify({ legacySignup: response.status, legacyLogin: login.status, pgConnections: startupCount - connectionsBefore, memberships: 0 }));
});
