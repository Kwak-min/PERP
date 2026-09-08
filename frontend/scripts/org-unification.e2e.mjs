import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer, preview } from "vite";
import react from "@vitejs/plugin-react";

// 모든 API를 격리한다. 실제 조직/사용자 DB에 요청하거나 쓰지 않는다.
const root = fileURLToPath(new URL("../", import.meta.url));
const built = process.env.ORG_BUILT === "1";
const evidence = `${root}/.artifacts/org-unification/${built ? "built" : "source"}`;
await mkdir(evidence, { recursive: true });
let vite, browser;
try {
  vite = built ? await preview({ configFile: false, root, preview: { host: "127.0.0.1", port: 0 } })
    : await createServer({ configFile: false, root, plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.artifacts/**", "**/dist/**"] } } });
  if (!built) await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });
  for (const pg of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ko-KR" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const orgId = pg ? "pg:77" : "isolated-org";
    const prefix = pg ? "/pg/members" : "/members";
    const permissions = ["member.read", "member.write", "role.assign", "department.write", "audit.read"];
    const organization = { org_id: orgId, org_name: "격리 검증 조직", org_type: "company", roles: ["custom-fixture-role"], permissions };
    const session = { token: "isolated-org-unification", orgId, name: "Fixture", email: "fixture@example.invalid", mustChangePassword: false, organizations: [organization] };
    await page.addInitScript(value => {
      localStorage.setItem("orbitflow.session.v1", JSON.stringify(value));
      localStorage.setItem("orbitflow.demoMode", "1");
      window.observeState = source => {
        const predicate = new Function(`return (${source})()`);
        if (predicate()) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => { if (predicate()) { observer.disconnect(); resolve(); } });
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          AbortSignal.timeout(10000).addEventListener("abort", () => { observer.disconnect(); reject(new Error("STATE_TIMEOUT")); }, { once: true });
        });
      };
    }, session);
    const settle = predicate => page.evaluate(source => window.observeState(source), predicate.toString());
    const m1 = { membership_id: "101", user_id: "101", name: "김검증", email: "kim@example.invalid", roles: ["custom-fixture-role"], status: "active", department_id: "10", title: "선임", phone: null };
    const m2 = { membership_id: "102", user_id: "102", name: "이기록", email: "lee@example.invalid", roles: ["reader"], status: "inactive", department_id: null, title: null };
    let members = [m1, m2], roots = [{ id: "10", name: "직접 만든 부서", parent_id: null, leader_id: "101", configured: true, leader: m1, members: [m1], member_count: 1, children: [] }];
    let dataStatus = 200, auditStatus = 200, grants = permissions;
    let auditItems = [{ id: "audit-real-fixture", seq: 7, action: "member.assignment.changed", action_label: "부서·직책 변경", resource_type: "membership", resource_id: "101", target: m1.name, actor_name: "감사 작성자", actor_kind: "user", before: { title: "사원" }, after: { title: "선임" }, created_at: "2026-09-07T00:00:00Z" }];
    const requests = [], mutations = [], errors = [];
    let auditRelease, auditStarted;
    await page.route("**/api/v1/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname.replace("/api/v1", "");
      requests.push(path);
      if (req.method() !== "GET") mutations.push(path);
      let status = 200, body = { items: [] };
      if (path === "/auth/me" || path === "/pg/auth/workspace") body = { organizations: [{ ...organization, permissions: grants }] };
      if (path === "/tenants/current") body = { ...organization, permissions: grants, enabled_modules: [] };
      if (path === "/settings/access") body = { org_id: orgId, permissions: grants, modules: ["members", "dashboard"], features: [], menus: ["menu.members", "menu.home"], scope: "all" };
      if (path === prefix) { status = dataStatus; body = { items: members }; }
      if (path === `${prefix}/org-chart`) { status = dataStatus; body = { roots, unassigned: members.filter(m => !m.department_id), ...(pg ? { revision: '1' } : {}) }; }
      if (path === `${prefix}/activity`) {
        if (auditStarted) { auditStarted(); await new Promise(resolve => { auditRelease = resolve; }); }
        status = auditStatus; body = { items: auditItems };
      }
      if (status !== 200) body = { error: { code: status === 501 ? "NOT_IMPLEMENTED" : status === 403 ? "PERMISSION_DENIED" : "SERVICE_UNAVAILABLE", message: "ISOLATED_API_ERROR", details: {}, request_id: "org-unification" } };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}/members`);
    await settle(() => document.querySelector('.orgchart__seat'));
    assert.equal(await page.locator(".org-directory tbody tr").count(), 2);
    assert.equal(await page.locator(".orgchart__seat").count(), 1);
    await settle(() => document.querySelector('[data-org-permissions="ready"]'));
    assert.equal(requests.some(p => p === `${prefix}/activity`), false);
    assert.equal(await page.locator('.sidebar nav a[href="/members"]').count(), 1);
    assert.equal(await page.locator('.sidebar nav a[href="/org-chart"], .sidebar nav a[href="/org-log"]').count(), 0);
    assert.equal(await page.locator('.sidebar nav a[href="/"]').count(), 1);
    await page.locator('.global-search input').fill("kim@example.invalid");
    await page.locator('.global-search input').press("Enter");
    await page.waitForURL(url => url.searchParams.get('q') === 'kim@example.invalid');
    await settle(() => document.querySelector('.org-directory input[type="search"]')?.value === 'kim@example.invalid');
    assert.equal(await page.locator('.org-directory input[type="search"]').inputValue(), "kim@example.invalid");
    assert.equal(await page.locator(".org-directory tbody tr").count(), 1);
    await page.locator(".org-directory tbody button").click();
    await settle(() => document.querySelector(".member-detail"));
    assert.equal(await page.locator('.member-detail a').getAttribute("href"), "/hr/members/101");
    await page.locator('.org-directory input[type="search"]').fill("");
    await page.locator('.org-directory select').first().selectOption("unassigned");
    assert.equal(await page.locator('.org-directory tbody tr').count(), 1);
    await page.locator('.org-directory select').first().selectOption("");
    await page.locator('.org-directory select').last().selectOption("inactive");
    assert.equal(await page.locator('.org-directory tbody tr').count(), 1);
    await page.locator('.org-directory select').last().selectOption("");
    const trigger = page.locator('button[aria-controls="org-log-dialog"]');
    assert.equal(await trigger.isEnabled(), true);
    const started = new Promise((resolve, reject) => {
      auditStarted = resolve;
      AbortSignal.timeout(10000).addEventListener("abort", () => reject(new Error("AUDIT_REQUEST_TIMEOUT")), { once: true });
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await started;
    await settle(() => document.querySelector('[data-org-log-state="loading"]'));
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-loading.png`, fullPage: true });
    auditStarted = null; auditRelease();
    await settle(() => document.querySelector('[data-org-log-state="ready"]'));
    assert.equal(await page.locator(".orglog-list > li").count(), 1);
    assert.equal(await page.locator('[data-org-log-state="ready"]').count(), 1);
    assert.equal(await page.locator('[data-org-log-state="empty"]').count(), 0);
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-popup.png`, fullPage: true });
    const focusables = dialog.locator('button:not([disabled]), input:not([disabled])');
    await focusables.last().focus(); await page.keyboard.press("Tab");
    assert.equal(await focusables.first().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focusables.last().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(new URL(page.url()).pathname, "/members");
    await page.setViewportSize({ width: 375, height: 812 });
    if (await page.locator('.sidebar-scrim--open').count()) {
      await page.getByRole('button', { name: '메뉴 닫기', exact: true }).click();
    }
    await page.locator('.sidebar').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    assert.equal(await page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right <= 0), true);
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-mobile.png`, fullPage: true, animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await trigger.click(); await settle(() => document.querySelector('[data-org-log-state="ready"]'));
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-mobile-popup.png`, animations: "disabled" });
    await dialog.locator('button[data-org-log-close]').click();
    assert.equal(await dialog.count(), 0);
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const status of [403, 503]) {
      auditStatus = status; await trigger.click();
      await settle(() => document.querySelector('[data-org-log-state="error"]'));
      assert.equal(await dialog.getByRole("alert").count(), 1);
      assert.equal(await page.locator('[data-org-log-state="empty"]').count(), 0);
      await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-audit-${status}.png` });
      await page.keyboard.press("Escape");
    }
    auditStatus = 200; auditItems = []; await trigger.click();
    await settle(() => document.querySelector('[data-org-log-state="empty"]'));
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-audit-empty.png` });
    await page.keyboard.press("Escape");
    await page.goto(`${origin}/org-log`);
    await page.waitForURL(url => url.pathname === '/members' && url.searchParams.get('org-log') === '1');
    await settle(() => document.querySelector('[data-org-log-state="empty"]'));
    await page.keyboard.press('Escape');
    await page.waitForURL(url => url.pathname === '/members' && !url.searchParams.has('org-log'));
    assert.equal(await dialog.count(), 0);
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    grants = ["member.read"];
    const permissionRefresh = page.waitForResponse(response => response.url().endsWith('/settings/access'));
    await page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed')));
    await permissionRefresh;
    await settle(() => document.querySelector('[data-org-permissions="ready"][data-org-state="ready"]'));
    assert.equal(await page.locator(".orgchart__actions button").count(), 0);
    assert.equal(await trigger.isDisabled(), pg);
    await page.locator(".org-directory tbody button").first().click();
    assert.equal(await page.locator(".member-detail__ladder").count(), 0);
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-readonly.png`, fullPage: true });
    members = []; roots = [];
    await page.goto(`${origin}/org-chart`);
    await settle(() => document.querySelector('[data-org-state="ready"]'));
    assert.equal(await page.locator(".org-directory tbody tr, .orgchart__seat").count(), 0);
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-empty.png`, fullPage: true });
    dataStatus = 403;
    await page.goto(`${origin}/org-chart`);
    await settle(() => document.querySelector('[data-org-state="error"]'));
    assert.equal(await page.locator(".org-directory tbody tr, .orgchart__seat").count(), 0);
    assert.equal(await page.locator(".screen [role=alert]").count(), 1);
    await page.screenshot({ path: `${evidence}/${pg ? "pg" : "legacy"}-denied.png`, fullPage: true });
    assert.equal(requests.some(path => path.startsWith(pg ? "/members" : "/pg/members")), false);
    assert.deepEqual(mutations, []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`ORG_UNIFICATION_${pg ? "PG" : "LEGACY"}_PASS`);
  }
} finally {
  await browser?.close();
  if (vite) {
    if (built) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
    else await vite.close();
  }
}
