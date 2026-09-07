import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { api, createOwnerOrg } from "../../backend/tests/http.js";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.resolve(frontend, "../.omo/operational-workflows-evidence");
const root = await mkdtemp(path.join(tmpdir(), "orbitflow-workflows-"));
await mkdir(evidence, { recursive: true });
let child;
let vite;
let browser;
let apiPort = 0;
async function startApi() {
  child = fork(fileURLToPath(new URL("./operational-api.mjs", import.meta.url)), [], {
    env: { ...process.env, PORT: String(apiPort), ORBITFLOW_DATABASE_FILE: path.join(root, "qa.db"), ORBITFLOW_AI_PROVIDER: "echo" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr.on("data", (data) => process.stderr.write(data));
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
  apiPort = ready.port;
}
async function stopApi() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(15000) });
  child.send("stop");
  await exited;
}
try {
  await startApi();
  const baseUrl = `http://127.0.0.1:${apiPort}/api/v1`;
  // Given: an isolated company, no local demo preference, and no task records.
  const owner = await createOwnerOrg(baseUrl, ["tasks", "projects", "calendar", "approvals", "finance", "members", "agent"]);
  const me = await api(baseUrl, "/auth/me", owner);
  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: "127.0.0.1", port: 0, watch: { ignored: ["**/.artifacts/**", "**/dist/**"] },
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const session = { token: owner.token, orgId: owner.orgId, name: me.body.name, email: me.body.email,
    mustChangePassword: false, organizations: me.body.organizations };
  await page.addInitScript((value) => localStorage.setItem("orbitflow.session.v1", JSON.stringify(value)), session);
  // When: the task entry point loads with a fresh browser preference.
  await page.goto(`${origin}/tasks`);
  await page.getByText("아직 업무 항목이 없습니다", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "tasks-initial.png") });
  // Then: no fixture task can be shown without an explicit demo opt-in.
  assert.equal(await page.getByRole("button", { name: "데모 OFF", exact: true }).count(), 1, "fresh browser must default demo OFF");
  // When: a user creates a task from the actual form.
  await page.getByRole("button", { name: "새로 만들기", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("이름", { exact: true }).fill("QA_TASK_PERSISTENT");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/v1/tasks") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();
  assert.equal((await saved).status(), 201);
  await page.getByRole("link", { name: "QA_TASK_PERSISTENT", exact: true }).waitFor();
  // Then: the server record survives a reload and a full API process restart.
  await page.reload();
  await page.getByRole("link", { name: "QA_TASK_PERSISTENT", exact: true }).waitFor();
  await stopApi();
  await startApi();
  await page.reload();
  await page.getByRole("link", { name: "QA_TASK_PERSISTENT", exact: true }).waitFor();

  // Given: the persisted task is open. When it is completed, Then the board reflects the server mutation.
  const completed = page.waitForResponse((r) => r.url().includes("/api/v1/tasks/") && r.request().method() === "PATCH");
  await page.getByRole("button", { name: "완료", exact: true }).click();
  assert.equal((await completed).status(), 200);
  await page.goto(`${origin}/projects/qa/board`);
  await page.getByText("QA_TASK_PERSISTENT", { exact: true }).waitFor();

  // Given: the organization calendar. When an event is created, Then the live month shows it after navigation.
  await page.goto(`${origin}/calendar`);
  await page.getByRole("button", { name: "새로 만들기", exact: true }).click();
  const start = new Date(Date.now() + 86_400_000);
  const localStart = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const startInput = page.getByLabel("시작 일시");
  await startInput.fill(localStart);
  assert.equal(await startInput.evaluate((element) => element === document.activeElement), true, "editing a secondary field must not reset focus");
  const confirmation = new Promise((resolve) => page.once("dialog", async (dialog) => { await dialog.dismiss(); resolve(dialog.message()); }));
  await page.keyboard.press("Escape");
  assert.match(String(await confirmation), /사라집니다/);
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("이름", { exact: true }).fill("QA_EVENT_PERSISTENT");
  const eventSaved = page.waitForResponse((r) => r.url().endsWith("/api/v1/calendar") && r.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "만들기", exact: true }).click();
  assert.equal((await eventSaved).status(), 201);
  await page.locator('[title*="QA_EVENT_PERSISTENT"]').waitFor();

  // Given: the owner is an approver. When a request is created and approved, Then both changes persist through the API.
  await page.goto(`${origin}/approvals`);
  await page.getByRole("button", { name: "새로 만들기", exact: true }).click();
  await page.getByLabel("이름", { exact: true }).fill("QA_APPROVAL_PERSISTENT");
  await page.getByLabel("결재자").selectOption(owner.userId);
  const approvalSaved = page.waitForResponse((r) => r.url().endsWith("/api/v1/approvals/requests") && r.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "만들기", exact: true }).click();
  assert.equal((await approvalSaved).status(), 201);
  await page.getByText("QA_APPROVAL_PERSISTENT", { exact: true }).waitFor();
  const approved = page.waitForResponse((r) => r.url().includes("/actions") && r.request().method() === "POST");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  assert.equal((await approved).status(), 200);

  // Given: a club member. When a dues rule and charge are created and paid, Then the charge status changes on the server-backed list.
  await page.goto(`${origin}/finance/dues`);
  await page.getByRole("button", { name: "새로 만들기", exact: true }).click();
  await page.getByLabel("이름", { exact: true }).fill("QA_DUES_PERSISTENT");
  await page.getByLabel("금액 (원)").fill("12000");
  await page.getByLabel("납부 대상").selectOption(owner.userId);
  const chargeSaved = page.waitForResponse((r) => r.url().endsWith("/api/v1/finance/dues/charges") && r.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "만들기", exact: true }).click();
  assert.equal((await chargeSaved).status(), 201);
  await page.getByText("12,000원", { exact: true }).waitFor();
  const paid = page.waitForResponse((r) => r.url().endsWith("/pay") && r.request().method() === "POST");
  await page.getByRole("button", { name: "납부 처리", exact: true }).click();
  assert.equal((await paid).status(), 200);
  await page.getByText("납부", { exact: true }).waitFor();

  // Given: live membership and agent surfaces. Then membership is localized and unsupported chat is honestly disabled.
  await page.goto(`${origin}/members`);
  await page.getByRole("button", { name: "구성원 목록 자세히 보기" }).last().click();
  await page.getByRole("dialog", { name: "구성원 목록" }).getByText("활성", { exact: true }).waitFor();
  await page.getByRole("button", { name: "구성원 목록 닫기" }).click();
  await page.getByRole("button", { name: "AI Agent" }).click();
  await page.getByText("대화 기능을 현재 사용할 수 없습니다", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "전송 사용 불가" }).isDisabled(), true);
  await page.getByRole("button", { name: "Agent 패널 닫기" }).click();

  const captures = [];
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["tasks", "calendar", "approvals", "finance-dues", "members"]) {
      const pathByRoute = { tasks: "/tasks", calendar: "/calendar", approvals: "/approvals", "finance-dues": "/finance/dues", members: "/members" };
      await page.goto(`${origin}${pathByRoute[route]}`);
      await page.locator(".section-card").first().waitFor();
      const filename = `${route}-${width}.png`;
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(evidence, filename), fullPage: true });
      captures.push(filename);
    }
    await page.goto(`${origin}/members`);
    await page.getByRole("button", { name: "구성원 목록 자세히 보기" }).last().click();
    const memberModalCapture = `member-modal-${width}.png`;
    await page.screenshot({ path: path.join(evidence, memberModalCapture) });
    captures.push(memberModalCapture);
    await page.getByRole("button", { name: "구성원 목록 닫기" }).click();
    await page.getByRole("button", { name: "AI Agent" }).click();
    const agentCapture = `agent-disabled-${width}.png`;
    await page.screenshot({ path: path.join(evidence, agentCapture), animations: "disabled" });
    captures.push(agentCapture);
    await page.getByRole("button", { name: "Agent 패널 닫기" }).click();
  }
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ result: "PASS", apiPort, frontendPort: vite.httpServer.address().port, persistence: "reload and full API process restart", isolated: true, workflows: ["tasks", "task-board", "calendar", "approvals", "membership", "dues", "agent-disabled"], captures }, null, 2));
  console.log("OPERATIONAL_WORKFLOWS_PASS");
} finally {
  await browser?.close();
  await vite?.close();
  await stopApi();
  await rm(root, { recursive: true, force: true });
}
