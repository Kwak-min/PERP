import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const appBase = process.env.ORBITFLOW_E2E_APP_URL ?? "http://127.0.0.1:4173";
const apiBase = process.env.ORBITFLOW_E2E_API_URL ?? "http://127.0.0.1:8111/api/v1";
const artifacts = path.resolve(".artifacts/visual-qa");
const email = `e2e-${Date.now()}@example.com`;
const password = "e2e-password-1234";
const consoleErrors = [];

async function api(route, { token, orgId, method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers["X-Org-Id"] = orgId;
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { status: response.status, body: payload };
}

await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme: "light",
  locale: "ko-KR",
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  console.log("E2E browser: signup and custom organization");
  await page.goto(`${appBase}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "OrbitFlow에 로그인" }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "login-1280.png"), fullPage: true });

  await page.getByRole("link", { name: "계정 만들기" }).click();
  await page.getByLabel("이름").fill("E2E 소유자");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByLabel("비밀번호 확인").fill(password);
  await page.getByLabel(/이용약관/).check();
  await page.getByRole("button", { name: "계정 만들기" }).click();
  await page.waitForURL("**/welcome");
  await page.getByRole("heading", { name: "어떤 방식으로 시작할까요?" }).waitFor();

  await page.getByRole("link", { name: /새 조직 만들기/ }).click();
  await page.getByRole("button", { name: /직접 설정/ }).click();
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByLabel("조직 이름").fill("OrbitFlow E2E");
  await page.getByLabel(/기본 부서/).fill("운영팀,재무팀");
  await page.getByRole("button", { name: "다음" }).click();
  for (const label of ["업무", "회계·재무", "전자결재", "AI Agent·개인 Vault"]) {
    await page
      .locator(`label.module-option:has(strong:text-is("${label}")) input[type="checkbox"]`)
      .check();
  }
  await page.getByRole("button", { name: "OrbitFlow 시작" }).click();
  await page.waitForURL(`${appBase}/`);
  await page.getByRole("heading", { name: "나의 홈" }).waitFor();

  const session = await page.evaluate(() => {
    const value = localStorage.getItem("orbitflow.session.v1");
    return value ? JSON.parse(value) : null;
  });
  assert(session?.token);
  assert(session?.orgId);
  const token = session.token;
  const orgId = session.orgId;
  const me = await api("/auth/me", { token });
  assert.equal(me.status, 200);
  const userId = me.body.id;

  console.log("E2E HTTP: module gating, task, transaction, approval, agent, vault");
  const disabledOrg = await api("/tenants", {
    token,
    method: "POST",
    body: { name: "Disabled Module Org", type: "custom", modules: [], departments: [] },
  });
  assert.equal(disabledOrg.status, 201);
  const disabled = await api("/finance/transactions", {
    token,
    orgId: disabledOrg.body.org_id,
  });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.body.error.code, "MODULE_DISABLED");
  assert.equal(
    (
      await api("/tenants/current", {
        token,
        orgId: disabledOrg.body.org_id,
        method: "PATCH",
        body: { modules: ["finance"] },
      })
    ).status,
    200,
  );
  assert.equal(
    (await api("/finance/transactions", { token, orgId: disabledOrg.body.org_id })).status,
    200,
  );
  const emptyOrg = await api("/tenants", {
    token,
    method: "POST",
    body: {
      name: "Empty Tasks Org",
      type: "custom",
      modules: ["tasks"],
      departments: [],
    },
  });
  assert.equal(emptyOrg.status, 201);

  const task = await api("/tasks", {
    token,
    orgId,
    method: "POST",
    body: { title: "E2E 업무" },
  });
  assert.equal(task.status, 201);
  const transaction = await api("/finance/transactions", {
    token,
    orgId,
    method: "POST",
    body: {
      kind: "expense",
      amount_minor: 25_000,
      occurred_on: "2026-08-10",
      memo: "E2E 거래",
    },
  });
  assert.equal(transaction.status, 201);
  const action = await api("/agent/actions", {
    token,
    orgId,
    method: "POST",
    body: {
      tool: "confirm.transaction",
      input: { transaction_id: transaction.body.id },
      approver_id: userId,
    },
  });
  assert.equal(action.status, 201);
  assert.equal(
    (
      await api(`/agent/actions/${action.body.id}/execute`, {
        token,
        orgId,
        method: "POST",
        body: { reauth_password: password },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api(`/approvals/requests/${action.body.approval_id}/actions`, {
        token,
        orgId,
        method: "POST",
        body: { decision: "approve" },
      })
    ).status,
    200,
  );
  const executed = await api(`/agent/actions/${action.body.id}/execute`, {
    token,
    orgId,
    method: "POST",
    body: { reauth_password: password },
  });
  assert.equal(executed.status, 200);
  assert(executed.body.rollback_ref);
  assert.equal(
    (
      await api(`/agent/actions/${action.body.id}/rollback`, {
        token,
        orgId,
        method: "POST",
      })
    ).status,
    200,
  );

  assert.equal(
    (
      await api("/vault/notes", {
        token,
        orgId,
        method: "POST",
        body: { title: "E2E A", content: "See [[E2E B]]" },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await api("/vault/notes", {
        token,
        orgId,
        method: "POST",
        body: { title: "E2E B", content: "Linked note" },
      })
    ).status,
    201,
  );
  const graph = await api("/vault/graph", { token, orgId });
  assert.equal(graph.status, 200);
  assert.equal(graph.body.nodes.length, 2);
  assert.equal(graph.body.edges.length, 1);

  console.log("E2E browser: desktop and mobile authenticated surfaces");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "나의 홈" }).waitFor();
  await page.locator(".spinner").waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(artifacts, "dashboard-1280.png"), fullPage: true });

  await page.getByRole("button", { name: "로그아웃" }).click();
  await page.waitForURL("**/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL(`${appBase}/`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "나의 홈" }).waitFor();

  async function selectOrg(selectedOrgId) {
    await page.evaluate((nextOrgId) => {
      const raw = localStorage.getItem("orbitflow.session.v1");
      if (!raw) throw new Error("Missing persisted E2E session");
      const current = JSON.parse(raw);
      localStorage.setItem(
        "orbitflow.session.v1",
        JSON.stringify({ ...current, orgId: nextOrgId }),
      );
    }, selectedOrgId);
  }

  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`${appBase}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "나의 홈" }).waitFor();
  await page.locator(".spinner").waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(artifacts, "dashboard-768.png"), fullPage: true });

  let releaseLoading;
  const loadingGate = new Promise((resolve) => {
    releaseLoading = resolve;
  });
  await page.route("**/api/v1/tasks", async (route) => {
    await loadingGate;
    await route.continue();
  });
  await page.goto(`${appBase}/tasks`, { waitUntil: "domcontentloaded" });
  await page.locator(".spinner").waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(artifacts, "loading-768.png"), fullPage: true });
  releaseLoading();
  await page.locator(".spinner").waitFor({ state: "hidden" });
  await page.unroute("**/api/v1/tasks");

  const expectedStateErrorStart = consoleErrors.length;
  await page.route("**/api/v1/tasks", (route) => route.abort("failed"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("데이터를 불러오지 못했습니다").waitFor();
  await page.screenshot({ path: path.join(artifacts, "error-768.png"), fullPage: true });
  await page.unroute("**/api/v1/tasks");

  await selectOrg(disabledOrg.body.org_id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("이 화면을 볼 권한이 없습니다").waitFor();
  await page.screenshot({ path: path.join(artifacts, "permission-768.png"), fullPage: true });
  const expectedStateErrors = consoleErrors.splice(expectedStateErrorStart);
  assert(expectedStateErrors.some((message) => message.includes("ERR_FAILED")));
  assert(expectedStateErrors.some((message) => message.includes("403 (Forbidden)")));
  assert(
    expectedStateErrors.every(
      (message) =>
        message.includes("ERR_FAILED") || message.includes("403 (Forbidden)"),
    ),
  );

  await selectOrg(emptyOrg.body.org_id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("아직 업무 항목이 없습니다").waitFor();
  await page.screenshot({ path: path.join(artifacts, "empty-768.png"), fullPage: true });

  await selectOrg(orgId);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${appBase}/tasks`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "업무" }).waitFor();
  await page.locator(".spinner").waitFor({ state: "hidden" });
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    clipped: [...document.querySelectorAll("h1,h2,p,button,a")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent?.trim())
      .filter(Boolean),
  }));
  assert.equal(overflow.document, 0);
  assert.deepEqual(overflow.clipped, []);
  await page.screenshot({ path: path.join(artifacts, "tasks-375.png"), fullPage: true });

  assert.deepEqual(consoleErrors, []);
  console.log("E2E GREEN");
  console.log(`Screenshots: ${artifacts}`);
  console.log(
    "Viewport checks: 1280x900, 768x900, 375x812; success/loading/error/permission/empty; horizontal overflow 0",
  );
} finally {
  await context.close();
  await browser.close();
}
