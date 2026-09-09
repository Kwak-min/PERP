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
const width = process.argv.includes("--mobile") ? 375 : 1280;
const evidence = path.join(frontend, ".artifacts/agent-chat", process.env.DEADLINE_RUN_ID ?? "local", String(width));
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "orbitflow-agent-chat-"));
let child;
let vite;
let browser;
try {
  child = fork(fileURLToPath(new URL("./operational-api.mjs", import.meta.url)), [], {
    env: { ...process.env, PORT: "0", ORBITFLOW_DATABASE_FILE: path.join(root, "qa.db"), ORBITFLOW_AI_PROVIDER: "echo" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr.on("data", data => process.stderr.write(data));
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
  const baseUrl = `http://127.0.0.1:${ready.port}/api/v1`;
  const owner = await createOwnerOrg(baseUrl, ["agent", "documents", "tasks", "approvals"]);
  const secondOrg = await api(baseUrl, "/tenants", { ...owner, method: "POST", body: {
    name: "SECOND_CHAT_SCOPE", type: "custom", modules: ["agent", "documents", "tasks", "approvals"], features: ["approvals"], departments: [],
  } });
  assert.equal(secondOrg.status, 201);
  const me = await api(baseUrl, "/auth/me", owner);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await api(baseUrl, "/tasks", { ...owner, method: "POST", body: { title: "CHAT_BROWSER_BRIEF", assignee_id: owner.userId, due_at: `${today}T12:00:00.000Z` } })).status, 201);
  assert.equal((await api(baseUrl, "/vault/notes", { ...owner, method: "POST", body: { title: "브라우저 개인 노트", content: "BROWSER_PRIVATE_VAULT_NEEDLE" } })).status, 201);
  const approval = await api(baseUrl, "/approvals/requests", { ...owner, method: "POST", body: { title: "CHAT_BROWSER_APPROVAL", steps: [{ approver_id: owner.userId }] } });
  assert.equal(approval.status, 201);

  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: {
    host: "127.0.0.1", port: 0, watch: { ignored: ["**/.artifacts/**", "**/dist/**"] }, proxy: { "/api": `http://127.0.0.1:${ready.port}` },
  } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript(value => localStorage.setItem("orbitflow.session.v1", JSON.stringify(value)), {
    token: owner.token, orgId: owner.orgId, name: me.body.name, email: me.body.email,
    mustChangePassword: false, organizations: me.body.organizations,
  });
  await page.goto(`${origin}/tasks`);
  await page.getByRole("button", { name: "AI Agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI Agent" });
  async function capture(name) {
    await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
  }
  await dialog.locator('[data-vault-mode="off"]').waitFor();

  const chatResponse = page.waitForResponse(response => response.url().endsWith("/api/v1/agent/chat") && response.request().method() === "POST");
  await dialog.getByLabel("Agent에게 요청").fill("BROWSER_PRIVATE_VAULT_NEEDLE");
  await dialog.getByRole("button", { name: "전송", exact: true }).click();
  const chat = await chatResponse;
  assert.equal(chat.status(), 200);
  const chatBody = await chat.json();
  assert.equal(chatBody.scope.vault_mode, "off");
  assert.equal(chatBody.answer.related_data.vault_notes_used, 0);
  await dialog.getByText("BROWSER_PRIVATE_VAULT_NEEDLE", { exact: true }).last().waitFor();

  let genericChatPosts = 0;
  page.on("request", request => { if (request.url().endsWith("/api/v1/agent/chat") && request.method() === "POST") genericChatPosts += 1; });
  const briefResponse = page.waitForResponse(response => response.url().endsWith("/api/v1/agent/brief"));
  await dialog.getByLabel("Agent에게 요청").fill("오늘 우선 처리할 업무를 근거와 함께 알려줘");
  await dialog.getByRole("button", { name: "전송", exact: true }).click();
  assert.equal((await briefResponse).status(), 200);
  assert.equal(genericChatPosts, 0, "named briefing intent must not be sent to generic chat");
  await dialog.getByText("CHAT_BROWSER_BRIEF", { exact: true }).waitFor();
  await capture("brief");

  await page.route("**/api/v1/agent/pending-approvals", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.items = body.items.map(item => ({ ...item, confirm_self_decision: true }));
    await route.fulfill({ response, json: body });
  });
  const pendingResponse = page.waitForResponse(response => response.url().endsWith("/api/v1/agent/pending-approvals"));
  await dialog.getByLabel("Agent에게 요청").fill("결재 대기 항목 보여줘");
  await dialog.getByRole("button", { name: "전송", exact: true }).click();
  assert.equal((await pendingResponse).status(), 200);
  assert.equal(genericChatPosts, 0, "named approval intent must not be sent to generic chat");
  await dialog.getByText("CHAT_BROWSER_APPROVAL", { exact: true }).waitFor();
  let decisionPosts = 0;
  page.on("request", request => { if (request.url().endsWith(`/api/v1/approvals/requests/${approval.body.id}/actions`) && request.method() === "POST") decisionPosts += 1; });
  await dialog.getByRole("button", { name: "CHAT_BROWSER_APPROVAL 승인" }).click();
  await dialog.getByRole("region", { name: "결재 결정 확인" }).waitFor();
  assert.equal(await dialog.getByRole("region", { name: "결재 결정 확인" }).evaluate(element => {
    const body = element.closest(".agent-panel__body");
    if (!body) return false;
    const bounds = element.getBoundingClientRect(), visible = body.getBoundingClientRect();
    return bounds.top >= visible.top && bounds.bottom <= visible.bottom;
  }), true, "decision confirmation must be visible without searching below the fold");
  assert.equal(decisionPosts, 0, "self-decision must wait for an explicit confirmation click");
  await capture("decision-confirmation");
  const decisionResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/approvals/requests/${approval.body.id}/actions`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "결정 전송", exact: true }).click();
  assert.equal((await decisionResponse).status(), 200);
  await dialog.getByText("CHAT_BROWSER_APPROVAL 요청을 승인했습니다.", { exact: true }).waitFor();

  const memoryLoaded = page.waitForResponse(response => response.url().endsWith("/api/v1/agent/memory") && response.request().method() === "GET");
  await dialog.getByLabel("Agent에게 요청").fill("AI 기억 보여줘");
  await dialog.getByRole("button", { name: "전송", exact: true }).click();
  assert.equal((await memoryLoaded).status(), 200);
  assert.equal(genericChatPosts, 0, "named memory intent must not be sent to generic chat");
  await dialog.getByLabel("기억 내용").fill("응답은 핵심부터 설명");
  const memoryCreated = page.waitForResponse(response => response.url().endsWith("/api/v1/agent/memory") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "기억 추가", exact: true }).click();
  assert.equal((await memoryCreated).status(), 201);
  await dialog.getByText("응답은 핵심부터 설명", { exact: true }).waitFor();
  await capture("memory");
  const memoryDeleted = page.waitForResponse(response => response.url().includes("/api/v1/agent/memory/") && response.request().method() === "DELETE");
  await dialog.getByRole("button", { name: "응답은 핵심부터 설명 삭제" }).click();
  assert.equal((await memoryDeleted).status(), 200);
  await dialog.getByRole("region", { name: "AI 기억 관리" }).getByText("저장된 AI 기억이 없습니다.", { exact: true }).waitFor();

  await dialog.getByLabel("기억 내용").fill("OLD_SCOPE_MEMORY_DRAFT");
  await dialog.getByRole("button", { name: "Agent 패널 닫기" }).click();
  await page.getByRole("button", { name: "AI Agent", exact: true }).click();
  assert.equal(await dialog.getByLabel("기억 내용").inputValue(), "OLD_SCOPE_MEMORY_DRAFT", "same account/company keeps its draft");
  const heldEntered = Promise.withResolvers();
  const releaseHeld = Promise.withResolvers();
  const heldSettled = Promise.withResolvers();
  await page.route("**/api/v1/agent/chat", async route => {
    if (route.request().postDataJSON()?.message !== "HELD_OLD_SCOPE_REQUEST") return route.continue();
    heldEntered.resolve();
    await releaseHeld.promise;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        conversation_id: "held-old-scope", answer: { conclusion: "HELD_OLD_SCOPE_RESPONSE", evidence: [], related_data: { vault_notes_used: 0 } },
        scope: { vault_mode: "off", personal_vault_used: false },
      }) });
    } catch { /* the keyed scope aborts the old request */ }
    heldSettled.resolve();
  });
  await dialog.getByLabel("Agent에게 요청").fill("HELD_OLD_SCOPE_REQUEST");
  await dialog.getByRole("button", { name: "전송", exact: true }).click();
  await heldEntered.promise;
  await dialog.getByRole("button", { name: "Agent 패널 닫기" }).click();
  if (width < 1100) await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.locator(".workspace-picker__button").click();
  await page.getByRole("menuitemradio", { name: /SECOND_CHAT_SCOPE/ }).click();
  if (width < 1100 && await page.getByRole("button", { name: "메뉴 닫기", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "메뉴 닫기", exact: true }).click();
  }
  await page.getByRole("button", { name: "AI Agent", exact: true }).click();
  const secondDialog = page.getByRole("dialog", { name: "AI Agent" });
  assert.equal(await secondDialog.getByLabel("Agent에게 요청").inputValue(), "");
  const secondMemoryLoaded = page.waitForResponse(response => response.url().endsWith("/api/v1/agent/memory") && response.request().method() === "GET");
  await secondDialog.getByRole("button", { name: "AI 기억 관리", exact: true }).click();
  assert.equal((await secondMemoryLoaded).status(), 200);
  assert.equal(await secondDialog.getByLabel("기억 내용").inputValue(), "", "old account/company memory draft must not survive the scope key");
  releaseHeld.resolve();
  await heldSettled.promise;
  assert.equal(await secondDialog.getByText("HELD_OLD_SCOPE_RESPONSE", { exact: true }).count(), 0, "late old-scope response must not enter the new panel");
  await capture("scope-cleared");
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ width, passed: true, errors, scenarios: ["chat-vault-off", "typed-brief", "typed-approvals", "self-confirmation", "memory-create-delete", "scope-isolation"] }, null, 2));

  console.log("AGENT_CHAT_BROWSER_PASS");
} finally {
  await browser?.close();
  await vite?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, "exit", { signal: AbortSignal.timeout(15000) });
    child.send("stop");
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
