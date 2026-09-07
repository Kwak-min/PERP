import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";
import { once } from "node:events";
import { chromium, expect } from "@playwright/test";

const distRoot = new URL("../dist/", import.meta.url);
const staticServer = createServer(async (req, res) => {
  const requested = req.url === "/" ? "index.html" : req.url?.slice(1);
  const candidate = requested && extname(requested) ? requested : "index.html";
  const content = await readFile(new URL(candidate, distRoot));
  res.setHeader("content-type", extname(candidate) === ".js" ? "text/javascript" : extname(candidate) === ".css" ? "text/css" : "text/html");
  res.end(content);
});
const staticReady = once(staticServer, "listening", { signal: AbortSignal.timeout(5000) });
staticServer.listen(0, "127.0.0.1");
await staticReady;
const address = staticServer.address();
assert(address && typeof address === "object");
const appUrl = `http://127.0.0.1:${address.port}`;
let browser = null;
let logoutAuthorization = null;

try {
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/pg/auth/login")) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "PG unavailable", details: {}, request_id: "qa" } }),
      });
    }
    if (path.endsWith("/auth/login")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: "legacy-token", must_change_password: false, user: { id: "user-1", email: "legacy@example.com", name: "레거시" } }),
      });
    }
    if (path.endsWith("/auth/me")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ organizations: [{ org_id: "org-1", org_name: "운영 조직", org_type: "company", roles: ["member"] }] }),
      });
    }
    if (path.endsWith("/auth/logout")) {
      logoutAuthorization = request.headers().authorization ?? null;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revoked: true }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });

  await page.goto(`${appUrl}/login`);
  await page.getByLabel("이메일").fill("legacy@example.com");
  await page.getByLabel("비밀번호").fill("password-1234");
  await page.getByLabel("로그인 유지").uncheck();
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/welcome"),
    page.getByRole("button", { name: "로그인" }).click(),
  ]);
  await page.getByRole("button", { name: /운영 조직/ }).click();
  await page.waitForURL((url) => url.pathname === "/");

  const selectedStorage = await page.evaluate(() => ({
    local: localStorage.getItem("orbitflow.session.v1"),
    session: sessionStorage.getItem("orbitflow.session.v1"),
  }));
  assert.equal(selectedStorage.local, null);
  assert.match(selectedStorage.session ?? "", /"orgId":"org-1"/);

  await Promise.all([
    page.waitForURL((url) => url.pathname === "/login"),
    page.getByRole("button", { name: "로그아웃" }).click(),
  ]);
  assert.equal(logoutAuthorization, "Bearer legacy-token");
  const cleared = await page.evaluate(() => ({
    local: localStorage.getItem("orbitflow.session.v1"),
    session: sessionStorage.getItem("orbitflow.session.v1"),
  }));
  assert.deepEqual(cleared, { local: null, session: null });

  const failures = [];
  for (const failure of [401, 503, "malformed", "missing", "bad-role"]) {
    const context = await browser.newContext();
    try {
      const check = await context.newPage();
      await check.addInitScript(() => {
        sessionStorage.setItem("orbitflow.session.v1", JSON.stringify({
          token: "verified-token", orgId: null, name: "Fixture", email: "fixture@example.com",
          mustChangePassword: false,
          organizations: [{ org_id: "stale-org", org_name: "Stale", org_type: null, roles: ["member"] }],
        }));
      });
      let recovered = false;
      await check.route("**/api/v1/auth/me", (route) => route.fulfill({
        status: recovered || typeof failure !== "number" ? 200 : failure,
        contentType: "application/json",
        body: JSON.stringify(recovered ? { organizations: [] } :
          failure === "malformed" ? { organizations: "invalid" } :
          failure === "missing" ? {} :
          failure === "bad-role" ? { organizations: [{ org_id: "org", org_name: "Org", org_type: null, roles: "owner" }] } :
          { error: { code: failure === 401 ? "UNAUTHENTICATED" : "SERVICE_UNAVAILABLE", message: "Fixture failure", details: {}, request_id: "qa" } }),
      }));
      await check.goto(`${appUrl}/welcome`);
      await expect(check.getByRole("alert")).toBeVisible({ timeout: 3000 });
      assert.equal(await check.locator('a[href="/onboarding/organization"]').count(), 0);
      assert.equal(await check.locator(".choice-card--button").count(), 0);
      recovered = true;
      await check.getByRole("button").click();
      await expect(check.locator('a[href="/onboarding/organization"]')).toBeVisible();
      assert.equal(await check.getByRole("alert").count(), 0);
      assert.equal(await check.locator(".choice-card--button").count(), 0);
      const stored = await check.evaluate(() => JSON.parse(sessionStorage.getItem("orbitflow.session.v1")));
      assert.deepEqual(stored.organizations, []);
      await check.route("**/api/v1/pg/auth/login", (route) => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ token: "pg-token", user: { id: "1", email: "fixture@example.com", name: "Fixture" } }),
      }));
      let legacyLogins = 0;
      await check.route("**/api/v1/auth/login", (route) => {
        legacyLogins++;
        return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
      });
      recovered = false;
      await check.goto(`${appUrl}/login`);
      await check.getByLabel("이메일").fill("fixture@example.com");
      await check.getByLabel("비밀번호").fill("password-1234");
      await check.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(check.getByRole("alert")).toBeVisible();
      assert.equal(new URL(check.url()).pathname, "/login");
      assert.equal(legacyLogins, 0);
      console.log(`MEMBERSHIP_LOOKUP_RECOVERY_PASS ${failure}`);
    } catch (error) {
      failures.push(new Error(`Membership lookup ${failure}: ${error.message}`));
    } finally {
      await context.close();
    }
  }
  assert.equal(failures.length, 0, failures.map((error) => error.message).join("\n"));
  console.log("QA_IDENTITY_LIFECYCLE_PASS");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve, reject) => staticServer.close((error) => error ? reject(error) : resolve()));
}
