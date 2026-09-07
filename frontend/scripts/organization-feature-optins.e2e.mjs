import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

import { api, startTestServer } from "../../backend/tests/http.js";
import { installCompanyFixture } from "../../backend/tests/pg-company-fixture.js";

process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(frontend, ".artifacts/organization-feature-optins");
await mkdir(evidence, { recursive: true });
const apiServer = await startTestServer();
const pgFixture = await installCompanyFixture();
let vite;
let browser;
const results = [];
const storageKey = "orbitflow.session.v1";
const password = "password-1234";

async function legacyAccount(email) {
  const signup = await api(apiServer.baseUrl, "/auth/signup", {
    method: "POST",
    body: { email, name: "기능 선택 QA", password },
  });
  assert.equal(signup.status, 201);
  const me = await api(apiServer.baseUrl, "/auth/me", { token: signup.body.access_token });
  assert.equal(me.status, 200);
  return {
    token: signup.body.access_token,
    orgId: null,
    name: me.body.name,
    email,
    mustChangePassword: false,
    organizations: [],
  };
}

async function pgAccount(email) {
  const login = await api(apiServer.baseUrl, "/pg/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(login.status, 200);
  return {
    token: login.body.token,
    orgId: null,
    name: login.body.user.name,
    email,
    mustChangePassword: false,
    organizations: [],
  };
}

async function createThroughOnboarding(page, origin, name, selectedFeatures, nativePg) {
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
    key: storageKey,
    session: nativePg ? await pgAccount(pgFixture.users[1].email) : await legacyAccount("feature-empty@example.invalid"),
  });
  await page.goto(origin + "/onboarding/organization");
  if (!nativePg) await page.getByRole("radio", { name: /직접 설정/ }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByLabel("조직 이름").fill(name);
  await page.getByRole("button", { name: "다음", exact: true }).click();

  for (const feature of ["근태", "휴가", "전자결재"]) {
    const checkbox = page.getByRole("checkbox", { name: new RegExp(`^${feature}`) });
    await checkbox.waitFor();
    assert.equal(await checkbox.isChecked(), false, `${feature} must start unchecked`);
    if (selectedFeatures.includes(feature)) await checkbox.check();
  }

  await page.getByRole("button", { name: "다음", exact: true }).click();
  const createPath = nativePg ? "/api/v1/pg/companies" : "/api/v1/tenants";
  const requestPromise = page.waitForRequest(request => new URL(request.url()).pathname === createPath && request.method() === "POST");
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === createPath && response.request().method() === "POST");
  await page.getByRole("button", { name: "조직 만들기", exact: true }).click();
  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  assert.equal(response.status(), 201);
  assert.deepEqual(request.postDataJSON().features.sort(), selectedFeatures.map(label => ({ 근태: "attendance", 휴가: "leave", 전자결재: "approvals" })[label]).sort());
  await page.waitForURL(url => url.pathname === "/");
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
}

async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await run(page);
    assert.deepEqual(errors, []);
    results.push({ name, result: "PASS" });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, result: "FAIL", error: String(error) });
    await page.screenshot({ path: path.join(evidence, `${name}-failure.png`), fullPage: true });
    throw error;
  } finally {
    await context.close();
  }
}

try {
  vite = await createServer({
    configFile: false,
    root: frontend,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: { ignored: ["**/.artifacts/**", "**/dist/**"] },
      proxy: { "/api": new URL(apiServer.baseUrl).origin },
    },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });

  await scenario("legacy-unchecked-disabled", async page => {
    const session = await createThroughOnboarding(page, origin, "기능 없음 조직", [], false);
    const access = await api(apiServer.baseUrl, "/settings/access", { token: session.token, orgId: session.orgId });
    assert.equal(access.status, 200);
    assert.deepEqual(access.body.features, []);
    const navigation = page.getByRole("navigation", { name: "주 메뉴" });
    await navigation.getByRole("link", { name: "홈", exact: true }).waitFor();
    for (const label of ["근태", "휴가", "결재"]) {
      assert.equal(await navigation.getByRole("link", { name: label, exact: true }).count(), 0, label);
    }
    for (const route of ["/hr/attendance", "/hr/leaves", "/approvals/requests"]) {
      const response = await api(apiServer.baseUrl, route, { token: session.token, orgId: session.orgId });
      assert.equal(response.status, 403, route);
      assert.equal(response.body.error.code, "FEATURE_DISABLED", route);
    }
    await page.screenshot({ path: path.join(evidence, "legacy-unchecked.png"), fullPage: true });
  });

  await scenario("pg-explicit-selection-relogin", async page => {
    let session = await createThroughOnboarding(page, origin, "PG 선택 기능 회사", ["휴가", "전자결재"], true);
    let access = await api(apiServer.baseUrl, "/settings/access", { token: session.token, orgId: session.orgId });
    assert.deepEqual(access.body.features, ["approvals", "leave"]);
    assert.equal((await api(apiServer.baseUrl, "/pg/hr/attendance", { token: session.token, orgId: session.orgId })).status, 403);
    assert.equal((await api(apiServer.baseUrl, "/pg/hr/leaves", { token: session.token, orgId: session.orgId })).status, 200);
    assert.equal((await api(apiServer.baseUrl, "/pg/approvals", { token: session.token, orgId: session.orgId })).status, 200);
    const navigation = page.getByRole("navigation", { name: "주 메뉴" });
    await navigation.getByRole("link", { name: "휴가", exact: true }).waitFor();
    assert.equal(await navigation.getByRole("link", { name: "근태", exact: true }).count(), 0);
    assert.equal(await navigation.getByRole("link", { name: "휴가", exact: true }).count(), 1);
    assert.equal(await navigation.getByRole("link", { name: "결재", exact: true }).count(), 1);

    const relogin = await api(apiServer.baseUrl, "/pg/auth/login", { method: "POST", body: { email: session.email, password } });
    const workspaces = await api(apiServer.baseUrl, "/pg/auth/workspace", { token: relogin.body.token });
    const selected = workspaces.body.organizations.find(org => org.org_id === session.orgId);
    assert.deepEqual(selected.enabled_features, ["approvals", "leave"]);
    session = { ...session, token: relogin.body.token };
    access = await api(apiServer.baseUrl, "/settings/access", { token: session.token, orgId: session.orgId });
    assert.deepEqual(access.body.features, ["approvals", "leave"]);
    await page.screenshot({ path: path.join(evidence, "pg-selected.png"), fullPage: true });
  });
} finally {
  await browser?.close();
  await vite?.close();
  await pgFixture.close();
  await apiServer.close();
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({
    results,
    pg: "SQL boundary fixture; no PostgreSQL server or real schema was contacted",
    cleanup: "Chrome, Vite, ERP API, PG fixture pool, and temporary SQLite directory closed",
  }, null, 2));
}

assert.ok(results.every(result => result.result === "PASS"), JSON.stringify(results, null, 2));
console.log("ORGANIZATION_FEATURE_OPTINS_BROWSER_PASS");
