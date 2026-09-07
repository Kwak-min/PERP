const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');

process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
const { prisma } = require('../src/lib/prisma');
const app = require('../src/app').default;
const originalCreate = prisma.space.create;
const originalAuthority = process.env.ERP_API_URL;
const mutations = [];
let authority;
let server;
let base;

before(async () => {
  const { permissionsFor } = await import('../../../backend/src/config/rbac.js');
  authority = http.createServer((req, res) => {
    // 테스트 토큰은 검증된 선택 조직의 역할 하나에 대응한다.
    const role = req.headers.authorization?.replace(/^Bearer /, '');
    if (!role) return res.writeHead(401).end();
    if (req.headers['x-org-id'] !== 'org-a') return res.writeHead(403).end();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      userId: 'user-a', tenantId: 'tenant-a', orgId: 'org-a', membershipId: 'membership-a',
      roles: [role], permissions: [...permissionsFor([role])], modules: ['assets'],
    }));
  });
  const authorityReady = once(authority, 'listening', { signal: AbortSignal.timeout(3000) });
  authority.listen(0, '127.0.0.1');
  await authorityReady;
  process.env.ERP_API_URL = `http://127.0.0.1:${authority.address().port}/api/v1`;
  prisma.space.create = async ({ data }) => {
    mutations.push(data);
    return { id: mutations.length, ...data };
  };
  server = http.createServer(app);
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(3000) });
  server.listen(0, '127.0.0.1');
  await ready;
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  prisma.space.create = originalCreate;
  if (originalAuthority === undefined) delete process.env.ERP_API_URL;
  else process.env.ERP_API_URL = originalAuthority;
  for (const listener of [server, authority]) {
    if (!listener?.listening) continue;
    const closed = once(listener, 'close', { signal: AbortSignal.timeout(3000) });
    listener.close();
    await closed;
  }
  await prisma.$disconnect();
});

for (const [role, orgId, status] of [
  ['org_admin', 'org-a', 403], ['owner', 'org-a', 201], ['company_admin', 'org-a', 201],
  ['admin', 'org-a', 403], ['ADMIN', 'org-a', 403],
  ['OWNER', 'org-a', 403], ['ORG_ADMIN', 'org-a', 403],
  ['super_admin', 'org-a', 403], ['other_org_admin', 'org-a', 403],
  ['dept_lead', 'org-a', 403], ['org_admin', 'org-b', 403],
]) {
  test(`Given verified ${role}, when creating a space in ${orgId}, then return ${status}`, async () => {
    // Given: 실제 ERP 역할 설정을 사용하는 로컬 인증 경계와 기록용 저장 어댑터.
    const beforeWrites = mutations.length;
    // When: 실제 Express 라우터와 컨트롤러를 통해 공간 생성.
    const response = await fetch(`${base}/api/v1/spaces`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${role}`, 'X-Org-Id': orgId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fixture', location: 'Fixture', capacity: 2 }),
    });
    // Then: 허용된 역할만 검증된 조직에 기록하고 나머지는 저장 전 차단.
    assert.equal(response.status, status);
    if (status === 201) {
      assert.equal(mutations.length, beforeWrites + 1);
      assert.equal(mutations.at(-1).tenantId, 'tenant-a');
      assert.equal(mutations.at(-1).orgId, 'org-a');
    } else {
      assert.equal(mutations.length, beforeWrites);
    }
  });
}
