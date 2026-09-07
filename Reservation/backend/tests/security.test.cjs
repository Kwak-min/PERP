const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
process.env.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:1/never_connect";
const { prisma } = require("../src/lib/prisma");
const app = require("../src/app").default;
let server;
let identityServer;
let base;
let reads = 0;
let lastWhere;
const originalFindMany = prisma.space.findMany;
const originalAttendeeFindUnique = prisma.attendee.findUnique;
const originalAttendeeUpdate = prisma.attendee.update;
before(async () => {
  identityServer = require("node:http").createServer((req, res) => {
    const orgId = req.headers["x-org-id"];
    const token = req.headers.authorization;
    if (token !== "Bearer valid") { res.writeHead(401).end(); return; }
    if (orgId !== "org-a") { res.writeHead(403).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ userId: "user-a", tenantId: "tenant-a", orgId: "org-a", membershipId: "membership-a", roles: ["member"], permissions: ["reservation.create"], modules: ["assets"] }));
  }).listen(0, "127.0.0.1");
  await once(identityServer, "listening");
  process.env.ERP_API_URL = `http://127.0.0.1:${identityServer.address().port}`;
  prisma.space.findMany = async ({ where }) => { reads++; lastWhere = where; return []; };
  prisma.attendee.findUnique = async ({ where }) => where.inviteToken === "invite-capability" ? { id: 3, status: "INVITED", inviteToken: "invite-capability", reservation: { id: 4, title: "Fixture", space: { name: "Room" } } } : null;
  prisma.attendee.update = async () => ({ id: 3, status: "DECLINED", inviteToken: "invite-capability", reservation: { id: 4, title: "Fixture", space: { name: "Room" } } });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  prisma.space.findMany = originalFindMany;
  prisma.attendee.findUnique = originalAttendeeFindUnique;
  prisma.attendee.update = originalAttendeeUpdate;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => identityServer.close(error => error ? reject(error) : resolve()));
  delete process.env.ERP_API_URL;
  await prisma.$disconnect();
});
test("Given a verified ERP principal, when listing spaces, then scope data to its organization", async () => {
  const response = await fetch(`${base}/api/v1/spaces`, { headers: { Authorization: "Bearer valid", "X-Org-Id": "org-a" }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal(lastWhere.tenantId, "tenant-a");
  assert.equal(lastWhere.orgId, "org-a");
});
test("Given a cross-organization header, when listing spaces, then reject before data access", async () => {
  const beforeReads = reads;
  const response = await fetch(`${base}/api/v1/spaces`, { headers: { Authorization: "Bearer valid", "X-Org-Id": "org-b" }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 403);
  assert.equal(reads, beforeReads);
});
test("Given no verified principal, when listing spaces, then reject before data access", async () => {
  const beforeReads = reads;
  const response = await fetch(`${base}/api/v1/spaces`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 401);
  assert.equal(reads, beforeReads);
});
test("Given an invitation capability without a session, when declining, then expose only response state", async () => {
  const response = await fetch(`${base}/api/v1/attendees/invite-capability/respond?accept=false`, { method: "PATCH", signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.data, { id: 3, status: "DECLINED" });
});
