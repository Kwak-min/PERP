const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:1/never_connect";
const { prisma } = require("../src/lib/prisma");
const { reservationService } = require("../src/modules/reservations/reservation.service");
const { attendeeService } = require("../src/modules/attendees/attendee.service");
const { createReservationSchema } = require("../src/modules/reservations/reservation.schema");
const { respondSchema } = require("../src/modules/attendees/attendee.schema");
const principal = { userId: "user-a", tenantId: "tenant-a", orgId: "org-a", roles: ["member"] };
const restores = [];
function replace(model, method, fn) {
  const original = model[method];
  model[method] = fn;
  restores.push(() => { model[method] = original; });
}
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
for (const [label, tenantId, orgId] of [["other organization", "tenant-a", "org-b"], ["other tenant", "tenant-b", "org-a"], ["legacy row", null, null]]) {
  test(`Given ${label}, when requesting reservation detail, then hide it`, async () => {
    const row = { id: 9, tenantId, orgId, userId: 1, ownerId: "user-a" };
    const find = async ({ where }) => Object.entries(where).every(([key, value]) => row[key] === value) ? row : null;
    replace(prisma.reservation, "findUnique", find);
    replace(prisma.reservation, "findFirst", find);
    await assert.rejects(reservationService.findById(9, principal), error => error.statusCode === 404);
  });
}
test("Given a spoofed userId, when parsing booking input, then reject it", () => {
  const parsed = createReservationSchema.safeParse({ spaceId: 1, userId: 999, title: "Fixture", startTime: "2030-01-01T09:00:00Z", endTime: "2030-01-01T10:00:00Z" });
  assert.equal(parsed.success, false);
});
test("Given a decline link, when parsing accept=false, then decline", () => {
  assert.equal(respondSchema.parse({ accept: "false" }).accept, false);
});
test("Given an attendee token, when listing attendees, then omit the capability", async () => {
  replace(prisma.reservation, "findFirst", async () => ({ id: 1, ownerId: "user-a", ...principal }));
  replace(prisma.attendee, "findMany", async ({ select }) => {
    const row = { id: 2, reservationId: 1, name: "Fixture", email: "fixture@example.invalid", department: null, status: "INVITED", inviteToken: "private-capability", createdAt: new Date() };
    return [select ? Object.fromEntries(Object.entries(row).filter(([key]) => select[key])) : row];
  });
  const rows = await attendeeService.findByReservation(1, principal);
  assert.equal("inviteToken" in rows[0], false);
});
test("Given an overlapping booking in the organization, when creating a booking, then reject before insert", async () => {
  let inserts = 0;
  replace(prisma.space, "findFirst", async ({ where }) => where.tenantId === "tenant-a" && where.orgId === "org-a" ? { id: 1, name: "Fixture" } : null);
  replace(prisma.reservation, "findFirst", async ({ where }) => where.tenantId === "tenant-a" && where.orgId === "org-a" ? { id: 7 } : null);
  replace(prisma.reservation, "create", async () => { inserts++; return {}; });
  const dto = createReservationSchema.parse({ spaceId: 1, title: "Fixture", startTime: "2030-01-01T09:00:00Z", endTime: "2030-01-01T10:00:00Z" });
  await assert.rejects(reservationService.create(dto, principal), error => error.statusCode === 409);
  assert.equal(inserts, 0);
});
test("Given the additive migration, when inspecting overlap enforcement, then include organization dimensions", () => {
  const sql = require("node:fs").readFileSync(require("node:path").join(__dirname, "../prisma/migrations/20260907010000_add_organization_scope/migration.sql"), "utf8");
  assert.match(sql, /"tenantId" WITH =, "orgId" WITH =, "spaceId" WITH =/);
  assert.doesNotMatch(sql, /DROP CONSTRAINT/);
  assert.match(sql, /tsrange\("startTime", "endTime", '\[\)'\) WITH &&/);
});
