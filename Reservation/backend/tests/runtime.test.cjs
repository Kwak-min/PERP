const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const net = require('node:net');
const { startDatabase, prismaCli } = require('./postgres-fixture.cjs');
const { startRuntime } = require('./runtime-fixture.cjs');

for (const host of [undefined, '127.0.0.2']) {
  test(`Given migrated PostgreSQL and HOST=${host ?? 'unset'}, when starting the real entry, then bind the requested loopback and serve Prisma-backed spaces`, { timeout: 60000 }, async t => {
    const fixture = await startDatabase();
    let runtime;
    // ERP는 별도 서비스이므로 로컬 HTTP 계약 픽스처만 사용한다. 실제 ERP 인증 증거가 아니다.
    const authority = http.createServer((req, res) => {
      if (req.url !== '/auth/reservation-principal' || req.headers.authorization !== 'Bearer fixture-token') return res.writeHead(401).end();
      const orgId = req.headers['x-org-id'];
      if (!['fixture-a', 'fixture-b'].includes(orgId)) return res.writeHead(403).end();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ userId: 'fixture-owner', tenantId: orgId, orgId, membershipId: 'fixture-member', roles: [], permissions: ['reservation.manage'], modules: ['assets'] }));
    });
    t.after(async () => {
      if (runtime) await runtime.close();
      if (authority.listening) {
        const closed = once(authority, 'close', { signal: AbortSignal.timeout(5000) });
        authority.close(); await closed;
      }
      await fixture.close();
    });
    await prismaCli(['migrate', 'deploy'], fixture.url);
    const authorityReady = once(authority, 'listening', { signal: AbortSignal.timeout(5000) });
    authority.listen(0, '127.0.0.1'); await authorityReady;
    runtime = startRuntime(fixture.url, { ERP_API_URL: `http://127.0.0.1:${authority.address().port}`, ...(host ? { HOST: host } : {}) });
    const listening = await runtime.ready;
    assert.equal(listening.kind, 'listening');
    assert.equal(listening.address.address, host ?? '127.0.0.1');
    assert.equal(listening.address.family, 'IPv4');
    assert.ok(listening.address.port > 0);
    assert.ok(fixture.server.getStats().activeConnections > 0);
    const base = `http://${listening.address.address}:${listening.address.port}`;
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok');
    assert.equal((await fetch(`${base}/api/v1/spaces`, { signal: AbortSignal.timeout(5000) })).status, 401);
    const request = async (method, orgId = 'fixture-a') => {
      const response = await fetch(`${base}/api/v1/spaces${method === 'POST' ? '/test-spaces' : ''}`, {
        method, signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Bearer fixture-token', 'X-Org-Id': orgId, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const first = await request('POST');
    assert.equal(first.createdCount, 5);
    assert.equal(first.spaces.length, 5);
    assert.ok(first.spaces.every(row => row.tenantId === 'fixture-a' && row.orgId === 'fixture-a' && row.capacity === 1));
    const replay = await request('POST');
    assert.equal(replay.createdCount, 0);
    assert.deepEqual(replay.spaces.map(row => row.id), first.spaces.map(row => row.id));
    assert.deepEqual((await request('GET')).map(row => row.id), first.spaces.map(row => row.id));
    assert.deepEqual(await request('GET', 'fixture-b'), []);
    const counts = await fixture.db.query('SELECT (SELECT count(*)::int FROM spaces) AS spaces, (SELECT count(*)::int FROM reservations) AS reservations, (SELECT count(*)::int FROM attendees) AS attendees');
    assert.deepEqual(counts.rows, [{ spaces: 5, reservations: 0, attendees: 0 }]);
    t.diagnostic(`Actual listener ${listening.address.address}:${listening.address.port}; health 200, unauthenticated 401; real Prisma creates 5, replay creates 0, foreign scope empty; no bookings/attendees`);
  });
}

test('Given unavailable PostgreSQL, when starting the real entry, then exit nonzero without listening', { timeout: 30000 }, async t => {
  const rejecting = net.createServer(socket => socket.destroy());
  const listening = once(rejecting, 'listening', { signal: AbortSignal.timeout(5000) });
  rejecting.listen(0, '127.0.0.1'); await listening;
  const runtime = startRuntime(`postgresql://fixture:fixture@127.0.0.1:${rejecting.address().port}/fixture?connect_timeout=1`);
  t.after(async () => {
    await runtime.close();
    const closed = once(rejecting, 'close', { signal: AbortSignal.timeout(5000) });
    rejecting.close(); await closed;
  });
  await assert.rejects(runtime.ready);
  assert.equal((await runtime.closed)[0], 1);
  assert.deepEqual(runtime.messages, []);
});
