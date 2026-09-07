import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createServer, preview } from "vite";
import react from "@vitejs/plugin-react";

// Isolated SPA: every API request is intercepted; no organization mutation reaches a real database.
const root = fileURLToPath(new URL("../", import.meta.url));
const built = process.env.NO_DEMO_BUILT === "1";
const evidence = `${root}/.artifacts/no-demo-defaults/${built ? "built" : "source"}`;
await mkdir(evidence, { recursive: true });
let vite, browser;
const failures = [];
try {
  vite = built
    ? await preview({ configFile: false, root, preview: { host: "127.0.0.1", port: 0 } })
    : await createServer({ configFile: false, root, plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.artifacts/**", "**/dist/**"] } } });
  if (!built) await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const session = { token: "isolated-token", orgId: "pg:77", name: "Owner", email: "owner@example.invalid", mustChangePassword: false, organizations: [{ org_id: "pg:77", org_name: "Isolated Company", org_type: "company", roles: ["owner"] }] };
  await page.addInitScript(value => {
    localStorage.setItem("orbitflow.session.v1", JSON.stringify(value));
    localStorage.setItem("orbitflow.demoMode", "1");
    window.waitForSurface = predicateSource => {
      const predicate = new Function(`return (${predicateSource})()`) ;
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const signal = AbortSignal.timeout(10000);
        const observer = new MutationObserver(() => {
          if (predicate()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        signal.addEventListener("abort", () => { observer.disconnect(); reject(signal.reason); }, { once: true });
      });
    };
  }, session);
  let memberStatus = 200, memberItems = [], departmentStatus = 200, departmentItems = [];
  const mutations = [];
  await page.route("**/api/v1/**", route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace("/api/v1", "");
    if (request.method() !== "GET") mutations.push({ path, method: request.method(), body: request.postDataJSON() });
    let status = 200, body = { items: [] };
    if (path === "/auth/me") body = { organizations: session.organizations };
    if (path === "/pg/auth/workspace") body = { organizations: session.organizations };
    if (path === "/pg/members") { status = memberStatus; body = { items: memberItems }; }
    if (path === "/pg/members/departments") { status = departmentStatus; body = { items: departmentItems }; }
    if (path === "/tenants/modules/catalog") body = { items: [{ key: "members", label: "Members", core: true, description: "Core" }] };
    if (path === "/tenants" && request.method() === "POST") { status = 201; body = { org_id: "isolated-new-org", name: "Explicit Company", type: "custom" }; }
    if (status !== 200 && status !== 201) body = { error: { code: status === 403 ? "FORBIDDEN" : "SERVICE_UNAVAILABLE", message: "ISOLATED_API_FAILURE", details: {}, request_id: "no-demo" } };
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  page.on("pageerror", error => failures.push(`pageerror: ${error}`));
  const settle = predicate => page.evaluate(source => window.waitForSurface(source), predicate.toString());
  async function check(name, fn) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(`${name}: ${error.message}`); console.error(`FAIL ${name}: ${error.message}`); }
  }
  await check("persisted demo=1 and empty API never render synthetic members", async () => {
    await page.goto(`${origin}/members`);
    await settle(() => document.querySelector('[data-screen-id="ORG-002"] .state-card:not([role="status"]), [data-screen-id="ORG-002"] tbody'));
    assert.equal(await page.locator('[data-screen-id="ORG-002"] tbody tr').count(), 0);
    assert.equal(await page.locator('[data-screen-id="ORG-002"] .stat-card').count(), 0);
    assert.equal(await page.locator('[data-screen-id="ORG-002"] .state-card').count(), 1);
  });
  for (const status of [403, 503]) await check(`persisted demo=1 preserves HTTP ${status}`, async () => {
    memberStatus = status;
    await page.goto(`${origin}/members`);
    await settle(() => document.querySelector('[data-screen-id="ORG-002"] [role="alert"], [data-screen-id="ORG-002"] tbody'));
    assert.equal(await page.locator('[data-screen-id="ORG-002"] tbody tr').count(), 0);
    assert.equal(await page.locator('[data-screen-id="ORG-002"] [role="alert"]').count(), 1);
  });
  memberStatus = 200;
  for (const path of ["/settings/roles", "/calendar", "/finance"]) await check(`empty ${path} has no synthetic visualizations`, async () => {
    await page.goto(`${origin}${path}`);
    await settle(() => document.querySelector('.screen .state-card:not([role="status"])'));
    assert.equal(await page.locator('.screen tbody tr, .screen .stat-card, .screen .calendar-event, .screen .brief-item').count(), 0);
  });
  await check("endpoint-free detail never invents facts", async () => {
    await page.goto(`${origin}/projects/explicit-project-id`);
    await settle(() => document.querySelector('.screen .kv-list'));
    assert.equal(await page.locator('.screen .kv-list > div').count(), 1);
    assert.equal(await page.locator('.screen .kv-list dd').textContent(), "explicit-project-id");
    assert.equal(await page.locator('.screen .stat-card').count(), 0);
  });
  await check("real members remain visible but empty member modal never falls back", async () => {
    memberItems = [{ membership_id: "member-explicit", user_id: "user-explicit", email: "explicit@example.invalid", name: "EXPLICIT_MEMBER", roles: ["member"], department_id: null, status: "active" }];
    await page.goto(`${origin}/members`);
    await settle(() => document.querySelector('[data-screen-id="ORG-002"] tbody tr'));
    assert.equal(await page.locator('[data-screen-id="ORG-002"] tbody tr').count(), 1);
    assert.equal(await page.locator('[data-screen-id="ORG-002"] tbody td').first().textContent(), "EXPLICIT_MEMBER");
    memberItems = [];
    await page.getByRole('button', { name: '구성원 목록 자세히 보기', exact: true }).first().click();
    await settle(() => document.querySelector('.member-modal__empty'));
    assert.equal(await page.locator('.member-modal__list li').count(), 0);
  });
  await check("empty departments API produces no branch rows", async () => {
    await page.goto(`${origin}/settings/branches`);
    await settle(() => document.querySelector('[data-screen-id="ORG-005"] .state-card:not([role="status"])'));
    assert.equal(await page.locator('.branch-list li').count(), 0);
    await page.locator('.workspace-picker__button').click();
    assert.equal(await page.locator('.workspace-picker__menu [role="menuitemradio"]').count(), 2);
    await page.screenshot({ path: `${evidence}/empty-branches-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${origin}/settings/branches`);
    await settle(() => document.querySelector('[data-screen-id="ORG-005"] .state-card:not([role="status"])'));
    await page.screenshot({ path: `${evidence}/empty-branches-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  await check("stored user departments remain visible", async () => {
    departmentItems = [{ id: "dept-explicit", name: "EXPLICIT_DEPARTMENT", parent_id: null, leader_id: null, access_roles: [], can_enter: true }];
    await page.goto(`${origin}/settings/branches`);
    await settle(() => document.querySelector('.branch-list li'));
    assert.equal(await page.locator('.branch-list li').count(), 1);
    assert.equal(await page.locator('.branch-list li b').textContent(), "EXPLICIT_DEPARTMENT");
  });
  await check("department API error is not presented as an empty organization", async () => {
    departmentStatus = 503;
    await page.goto(`${origin}/settings/branches`);
    await settle(() => document.querySelector('[data-screen-id="ORG-005"] [role="alert"]'));
    assert.equal(await page.locator('.branch-list li').count(), 0);
    assert.equal(await page.locator('[data-screen-id="ORG-005"] [role="alert"]').count(), 1);
  });
  departmentStatus = 200; departmentItems = [];
  await check("new custom organization submits no prefilled departments", async () => {
    await page.goto(`${origin}/onboarding/organization`);
    await page.locator('[role="radio"]').last().click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.locator('input[required]').fill('Explicit Company');
    assert.equal(await page.locator('.form-stack > label').last().locator('input').inputValue(), "");
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByRole('button', { name: '다음', exact: true }).click();
    const submitted = page.waitForRequest(request => request.url().endsWith('/api/v1/tenants') && request.method() === 'POST');
    await page.getByRole('button', { name: '조직 만들기', exact: true }).click();
    assert.deepEqual((await submitted).postDataJSON().departments, []);
  });
  assert.equal(mutations.filter(request => request.path !== '/tenants').length, 0);
  assert.deepEqual(failures, []);
  console.log(`NO_DEMO_DEFAULTS_BROWSER_PASS ${built ? 'built' : 'source'}`);
} finally {
  await browser?.close();
  if (vite) {
    if (built) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
    else await vite.close();
  }
}
