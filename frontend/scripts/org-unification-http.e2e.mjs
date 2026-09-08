import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { api, createOwnerOrg, startTestServer } from "../../backend/tests/http.js";
import { installCompanyFixture } from "../../backend/tests/pg-company-fixture.js";

// 실제 Express/인증/감사 기록 + 임시 SQLite, PG는 SQL 경계 fixture만 사용한다.
process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = `${root}/.artifacts/org-unification/http`;
await mkdir(evidence, { recursive: true });
let server, vite, browser, fixture;
try {
  server = await startTestServer();
  vite = await createServer({ configFile: false, root, plugins: [react()], server: { host: "127.0.0.1", port: 0, proxy: { "/api": new URL(server.baseUrl).origin }, watch: { ignored: ["**/.artifacts/**", "**/dist/**"] } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });
  const owner = await createOwnerOrg(server.baseUrl, ["members"]);
  const department = await api(server.baseUrl, "/members/departments", { method: "POST", ...owner, body: { name: "명시적 검증 부서" } });
  assert.equal(department.status, 201);
  const audit = await api(server.baseUrl, "/members/activity?limit=200", owner);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.some(item => item.resource_id === department.body.id));
  const plans = [{ pg: false, ...owner, name: "Owner", email: "isolated@example.invalid", auditCount: audit.body.items.length }];
  fixture = await installCompanyFixture();
  fixture.state.permissions.push(...["member.read", "audit.read", "menu.members", "menu.home"].map(code => ({ role_id: "1", code })));
  fixture.state.departments.push({ id: "901", company_id: "77", name: "PG 명시적 검증 부서", parent_id: null, manager_id: "101" });
  fixture.state.memberships[0].department_id = "901";
  const login = await api(server.baseUrl, "/pg/auth/login", { method: "POST", body: { email: fixture.users[0].email, password: "password-1234" } });
  assert.equal(login.status, 200);
  plans.push({ pg: true, token: login.body.token, orgId: "pg:77", name: fixture.users[0].name, email: fixture.users[0].email, auditCount: 0 });
  for (const plan of plans) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ko-KR" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], writes = [], responses = [];
    const session = { token: plan.token, orgId: plan.orgId, name: plan.name, email: plan.email, mustChangePassword: false, organizations: [{ org_id: plan.orgId, org_name: "HTTP 격리 검증", org_type: "company", roles: [] }] };
    await page.addInitScript(value => { localStorage.setItem("orbitflow.session.v1", JSON.stringify(value)); localStorage.setItem("orbitflow.demoMode", "1"); }, session);
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (response.url().includes("/api/v1/")) responses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    await page.route("**/api/v1/**", async route => {
      if (route.request().method() !== "GET") { writes.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    await page.goto(`${origin}/org-chart`);
    await page.locator('[data-org-state="ready"][data-org-permissions="ready"]').waitFor();
    assert.equal(await page.locator(".org-directory tbody tr").count(), 1);
    assert.equal(await page.locator(".orgchart__seat").count(), 1);
    assert.equal(await page.locator(".orgchart__department").textContent(), plan.pg ? "PG 명시적 검증 부서" : "명시적 검증 부서");
    await page.screenshot({ path: `${evidence}/${plan.pg ? "pg" : "legacy"}-directory.png`, fullPage: true });
    const popupResponse = page.waitForResponse(response => response.url().includes("/members/activity?limit=200"));
    await page.locator('button[aria-controls="org-log-dialog"]').click();
    assert.equal((await popupResponse).status(), 200);
    await page.locator(plan.pg ? '[data-org-log-state="empty"]' : '[data-org-log-state="ready"]').waitFor();
    assert.equal(await page.locator(".orglog-list > li").count(), plan.auditCount);
    if (!plan.pg) assert.equal(await page.locator(".orglog-item__target").allTextContents().then(items => items.includes("명시적 검증 부서")), true);
    await page.screenshot({ path: `${evidence}/${plan.pg ? "pg" : "legacy"}-audit.png` });
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(JSON.stringify({ name: `ORG_UNIFICATION_HTTP_${plan.pg ? "PG_SQL_FIXTURE" : "LEGACY_SQLITE"}_PASS`, responses, browserWrites: writes.length }));
    await context.close();
  }
} finally {
  await browser?.close();
  await vite?.close();
  if (fixture) await fixture.close();
  await server?.close();
  console.log("ORG_UNIFICATION_HTTP_CLEANUP_COMPLETE");
}
