import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

const password = "member-security-password-1234";
const emailFor = (label) => `${label}-${crypto.randomUUID()}@example.com`;

describe("member provisioning credentials and bounded role delegation", { timeout: 30000 }, () => {
  let server;
  let db;
  let owner;
  const actors = {};

  const request = (actor, route, method = "GET", body) => api(server.baseUrl, route, {
    token: actor.token,
    orgId: actor.orgId ?? owner.orgId,
    method,
    body,
  });

  async function signup(email = emailFor("account")) {
    const result = await api(server.baseUrl, "/auth/signup", {
      method: "POST",
      body: { email, name: "Security member", password },
    });
    assert.equal(result.status, 201);
    return { email, token: result.body.access_token, userId: result.body.user.id };
  }

  async function join(role = "member") {
    const email = emailFor(role);
    const invite = await request(owner, "/members/invites", "POST", { email, roles: [role] });
    assert.equal(invite.status, 201);
    const member = await signup(email);
    const accepted = await request(member, "/auth/invitations/accept", "POST", { token: invite.body.token });
    assert.equal(accepted.status, 201);
    const membership = db().prepare("SELECT * FROM membership WHERE org_id = ? AND user_id = ?")
      .get(owner.orgId, member.userId);
    return { ...member, membershipId: membership.id };
  }

  before(async () => {
    server = await startTestServer();
    ({ db } = await import("../src/config/db.js"));
    const databaseFile = db().prepare("PRAGMA database_list").get().file;
    assert.equal(path.dirname(path.dirname(databaseFile)), tmpdir());
    assert.match(path.basename(path.dirname(databaseFile)), /^orbitflow-test-/);
    owner = await createOwnerOrg(server.baseUrl, []);
    for (const role of ["hr", "dept_lead", "org_admin"]) actors[role] = await join(role);
  });

  after(async () => {
    if (!server) return;
    const databaseRoot = path.dirname(process.env.ORBITFLOW_DATABASE_FILE);
    await server.close();
    await assert.rejects(access(databaseRoot), { code: "ENOENT" });
  });

  it("cannot provision a foreign organization's owner or change their credentials/session", async () => {
    const victim = await createOwnerOrg(server.baseUrl, []);
    const beforeUser = db().prepare("SELECT * FROM app_user WHERE id = ?").get(victim.userId);
    const attempted = await request(owner, "/members/provision", "POST", {
      email: beforeUser.email.toUpperCase(), name: "Attacker supplied name", roles: ["member"],
    });
    const login = await api(server.baseUrl, "/auth/login", {
      method: "POST", body: { email: beforeUser.email, password: "password-1234" },
    });
    const session = await request(victim, "/members");
    const afterUser = db().prepare("SELECT * FROM app_user WHERE id = ?").get(victim.userId);
    const unauthorizedMembership = db().prepare("SELECT id FROM membership WHERE org_id = ? AND user_id = ?")
      .get(owner.orgId, victim.userId);
    assert.deepEqual({
      provision: attempted.status,
      login: login.status,
      existingSession: session.status,
      credentialsUnchanged: afterUser.password_hash === beforeUser.password_hash,
      passwordChangeRequired: afterUser.must_change_password,
      unauthorizedMembership: Boolean(unauthorizedMembership),
      temporaryPasswordDisclosed: "temporary_password" in attempted.body,
    }, {
      provision: 409, login: 200, existingSession: 200, credentialsUnchanged: true,
      passwordChangeRequired: 0, unauthorizedMembership: false, temporaryPasswordDisclosed: false,
    });
  });

  for (const status of ["none", "active", "inactive", "left", "deleted"]) {
    it(`rejects existing accounts with ${status} local membership without changing account or membership`, async () => {
      const member = status === "none" ? await signup() : await join();
      if (["inactive", "left"].includes(status)) {
        const changed = await request(owner, `/members/${member.membershipId}/status`, "PATCH", { status });
        assert.equal(changed.status, 200);
      }
      if (status === "deleted") {
        db().prepare("UPDATE membership SET deleted_at = ? WHERE id = ?")
          .run("2000-01-01T00:00:00.000Z", member.membershipId);
      }
      const beforeUser = db().prepare("SELECT * FROM app_user WHERE id = ?").get(member.userId);
      const beforeMemberships = db().prepare("SELECT * FROM membership WHERE user_id = ?").all(member.userId);
      const attempted = await request(owner, "/members/provision", "POST", {
        email: member.email, name: "Replacement", roles: ["member"],
      });
      assert.equal(attempted.status, 409);
      assert.equal(attempted.body.error.code, "CONFLICT");
      assert.deepEqual(db().prepare("SELECT * FROM app_user WHERE id = ?").get(member.userId), beforeUser);
      assert.deepEqual(db().prepare("SELECT * FROM membership WHERE user_id = ?").all(member.userId), beforeMemberships);
    });
  }

  it("joins an existing account only through authenticated secret-token invitation acceptance", async () => {
    const victim = await createOwnerOrg(server.baseUrl, []);
    const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(victim.userId);
    const invite = await request(owner, "/members/invites", "POST", { email: user.email, roles: ["member"] });
    assert.equal(invite.status, 201);
    const idOnly = await request(owner, "/auth/invitations/accept", "POST", { invitation_id: invite.body.id });
    assert.equal(idOnly.status, 400);
    assert.equal(db().prepare("SELECT status FROM invitation WHERE id = ?").get(invite.body.id).status, "pending");
    const accepted = await request(victim, "/auth/invitations/accept", "POST", { token: invite.body.token });
    assert.equal(accepted.status, 201);
    assert.equal((await request({ ...victim, orgId: owner.orgId }, "/members")).status, 200);
    assert.equal((await request(victim, "/members")).status, 200);
    assert.equal(db().prepare("SELECT password_hash FROM app_user WHERE id = ?").get(victim.userId).password_hash, user.password_hash);
  });

  for (const actorRole of ["hr", "dept_lead"]) {
    for (const route of ["invites", "provision"]) {
      for (const delegatedRole of ["member", "owner", "org_admin", "treasurer", "platform_admin"]) {
        it(`denies ${actorRole} ${route} assigning ${delegatedRole} without role.assign`, async () => {
          const email = emailFor("forbidden");
          const result = await request(actors[actorRole], `/members/${route}`, "POST", {
            email, name: "Unauthorized", roles: [delegatedRole],
          });
          assert.equal(result.status, 403);
          assert.equal(result.body.error.code, "PERMISSION_DENIED");
          assert.equal(db().prepare("SELECT id FROM app_user WHERE email = ?").get(email), undefined);
          assert.equal(db().prepare("SELECT id FROM invitation WHERE org_id = ? AND email = ?").get(owner.orgId, email), undefined);
        });
      }
    }
  }

  for (const route of ["invites", "provision", "roles"]) {
    for (const delegatedRole of ["owner", "treasurer", "hr", "platform_admin"]) {
      it(`bounds org_admin ${route} delegation of ${delegatedRole} to the caller's permissions`, async () => {
        const target = route === "roles" ? await join() : null;
        const result = await request(actors.org_admin,
          target ? `/members/${target.membershipId}/roles` : `/members/${route}`,
          target ? "PATCH" : "POST",
          { email: emailFor("bounded"), name: "Bounded", roles: [delegatedRole] });
        assert.equal(result.status, 403);
        assert.equal(result.body.error.code, "PERMISSION_DENIED");
        if (target) {
          assert.equal(db().prepare("SELECT roles FROM membership WHERE id = ?").get(target.membershipId).roles, "member");
        }
      });
    }
  }

  it("does not let org_admin demote an owner it cannot administer", async () => {
    const membership = db().prepare("SELECT id FROM membership WHERE org_id = ? AND user_id = ?")
      .get(owner.orgId, owner.userId);
    const result = await request(actors.org_admin, `/members/${membership.id}/roles`, "PATCH", { roles: ["member"] });
    assert.equal(result.status, 403);
    assert.equal(db().prepare("SELECT roles FROM membership WHERE id = ?").get(membership.id).roles, "owner");
  });

  it("does not treat prototype keys as known role templates", async () => {
    for (const role of ["__proto__", "constructor", "toString"]) {
      const result = await request(owner, "/members/invites", "POST", { email: emailFor("invalid"), roles: [role] });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "VALIDATION_ERROR");
    }
  });

  it("does not let an organization owner delegate platform_admin", async () => {
    const result = await request(owner, "/members/invites", "POST", {
      email: emailFor("platform"), roles: ["platform_admin"],
    });
    assert.equal(result.status, 403);
  });

  it("allows owner role workflows and org_admin delegation within its authority", async () => {
    const member = await join();
    for (const role of ["org_admin", "owner", "member"]) {
      const changed = await request(owner, `/members/${member.membershipId}/roles`, "PATCH", { roles: [role] });
      assert.equal(changed.status, 200);
      assert.deepEqual(changed.body.roles, [role]);
    }
    for (const role of ["dept_lead", "member", "org_admin"]) {
      const changed = await request(actors.org_admin, `/members/${member.membershipId}/roles`, "PATCH", { roles: [role] });
      assert.equal(changed.status, 200);
    }
    for (const route of ["invites", "provision"]) {
      const result = await request(actors.org_admin, `/members/${route}`, "POST", {
        email: emailFor("allowed"), name: "Allowed", roles: ["member"],
      });
      assert.equal(result.status, 201);
    }
  });

  it("allows owner provisioning and temporary-password reissue, but never resets a claimed account", async () => {
    const email = emailFor("temporary");
    const provisioned = await request(owner, "/members/provision", "POST", { email, name: "Temporary" });
    assert.equal(provisioned.status, 201);
    const login = await api(server.baseUrl, "/auth/login", {
      method: "POST", body: { email, password: provisioned.body.temporary_password },
    });
    assert.equal(login.status, 200);
    assert.equal((await request({ token: login.body.access_token }, "/members")).body.error.code, "PASSWORD_CHANGE_REQUIRED");
    const reset = await request(owner, `/members/${provisioned.body.membership_id}/reset-password`, "POST");
    assert.equal(reset.status, 200);
    assert.equal((await request({ token: login.body.access_token }, "/auth/me")).status, 401);
    const relogin = await api(server.baseUrl, "/auth/login", {
      method: "POST", body: { email, password: reset.body.temporary_password },
    });
    assert.equal(relogin.status, 200);
    const changed = await request({ token: relogin.body.access_token }, "/auth/password", "POST", {
      current_password: reset.body.temporary_password, new_password: password,
    });
    assert.equal(changed.status, 200);
    const claimed = await api(server.baseUrl, "/auth/login", { method: "POST", body: { email, password } });
    assert.equal(claimed.status, 200);
    assert.equal((await request({ token: claimed.body.access_token }, "/members")).status, 200);
    const denied = await request(owner, `/members/${provisioned.body.membership_id}/reset-password`, "POST");
    assert.equal(denied.status, 409);
    assert.equal((await request({ token: claimed.body.access_token }, "/members")).status, 200);
  });

  it("does not let member.write reset an owner's global credentials", async () => {
    const membership = db().prepare("SELECT id FROM membership WHERE org_id = ? AND user_id = ?")
      .get(owner.orgId, owner.userId);
    const beforeUser = db().prepare("SELECT * FROM app_user WHERE id = ?").get(owner.userId);
    const result = await request(actors.hr, `/members/${membership.id}/reset-password`, "POST");
    assert.equal(result.status, 403);
    assert.deepEqual(db().prepare("SELECT * FROM app_user WHERE id = ?").get(owner.userId), beforeUser);
  });

  it("does not let a second organization reset an invited existing account", async () => {
    const other = await createOwnerOrg(server.baseUrl, []);
    const member = await join();
    const invite = await request(other, "/members/invites", "POST", { email: member.email });
    assert.equal(invite.status, 201);
    assert.equal((await request(member, "/auth/invitations/accept", "POST", { token: invite.body.token })).status, 201);
    const membership = db().prepare("SELECT id FROM membership WHERE org_id = ? AND user_id = ?")
      .get(other.orgId, member.userId);
    const reset = await request(other, `/members/${membership.id}/reset-password`, "POST");
    const login = await api(server.baseUrl, "/auth/login", { method: "POST", body: { email: member.email, password } });
    assert.deepEqual({ reset: reset.status, login: login.status }, { reset: 409, login: 200 });
  });

  it("allows re-invitation after expiry and rejects the expired token", async () => {
    const member = await signup();
    const expired = await request(owner, "/members/invites", "POST", { email: member.email });
    assert.equal(expired.status, 201);
    db().prepare("UPDATE invitation SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", expired.body.id);
    const fresh = await request(owner, "/members/invites", "POST", { email: member.email });
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.body.token, expired.body.token);
    const staleAccept = await request(member, "/auth/invitations/accept", "POST", { token: expired.body.token });
    assert.equal(staleAccept.status, 400);
    assert.equal((await request(member, "/auth/invitations/accept", "POST", { token: fresh.body.token })).status, 201);
  });

  it("canonicalizes invitation emails and blocks active pending duplicates independent of case", async () => {
    const email = emailFor("duplicate");
    const first = await request(owner, "/members/invites", "POST", { email: email.toUpperCase() });
    assert.equal(first.status, 201);
    assert.equal(first.body.email, email);
    const duplicate = await request(owner, "/members/invites", "POST", { email });
    assert.equal(duplicate.status, 409);
  });
});
