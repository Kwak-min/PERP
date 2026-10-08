import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createServer as createVite } from "vite";
import react from "@vitejs/plugin-react";
import { calls, operations, releaseHeld, fixture, protectedResult } from "./inapp-agent-ui-fixture.mjs";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const insecure = process.argv.includes("--insecure");
const browserHost = insecure ? "inapp-agent.test" : "127.0.0.1";
assert.ok(process.env.DEADLINE_TEMP_ROOT, "Run through scripts/run_deadline_isolated.mjs");
let vite, browser;
try {
  const listening = once(fixture, "listening");
  fixture.listen(0, "127.0.0.1");
  await listening;
  vite = await createVite({ configFile: false, root: frontend, cacheDir: `${process.env.DEADLINE_TEMP_ROOT}/vite-cache`, plugins: [react(), { name: "agent-fixture",
    configureServer(server) { server.middlewares.use("/agent-fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/agent-fixture", '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/inapp-agent-entry.tsx"></script></body></html>'));
    }); },
  }], server: { host: "127.0.0.1", allowedHosts: ["inapp-agent.test"], port: 0, proxy: { "/api": `http://127.0.0.1:${fixture.address().port}` } } });
  await vite.listen();
  browser = await chromium.launch({ channel: "chrome", args: insecure ? ["--host-resolver-rules=MAP inapp-agent.test 127.0.0.1", "--no-proxy-server"] : [] });
  const width = Number(process.argv.find(arg => arg.startsWith("--width="))?.split("=")[1] || 1280);
  const evidence = fileURLToPath(new URL(`../../.omo/inapp-agent/${insecure ? "insecure-screenshots" : "screenshots"}/${width}/`, import.meta.url));
  await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(`BROWSER_PAGE_ERROR ${error.message}`); });
  await page.route("**/*", route => ["inapp-agent.test", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.addInitScript(() => localStorage.setItem("orbitflow.session.v1", JSON.stringify({
    token: "fixture-account", orgId: "legacy-one", name: "테스트", email: "fixture@example.invalid",
    mustChangePassword: false, organizations: [],
  })));
  await page.goto(`http://${browserHost}:${vite.httpServer.address().port}/agent-fixture`);
  if (insecure) {
    const cryptoSurface = await page.evaluate(() => ({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues }));
    assert.deepEqual(cryptoSurface, { secure: false, randomUUID: "undefined", getRandomValues: "function" });
    console.log(`INSECURE_ORIGIN_VERIFIED ${JSON.stringify(cryptoSurface)}`);
  }
  await page.getByRole("button", { name: "AI Agent", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "AI Agent" });
  async function capture(name) {
    await page.screenshot({ path: `${evidence}${name}.png`, animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
  }
  async function send(message) {
    const response = page.waitForResponse(r => r.url().endsWith("/chat"));
    await panel.getByLabel("Agent에게 요청").fill(message);
    await panel.getByRole("button", { name: "전송", exact: true }).click();
    await response;
  }
  await send("보호 조회");
  const protectedView = panel.locator('[data-protected-result="protected-call"]');
  await protectedView.waitFor();
  await protectedView.locator("summary").click();
  assert.deepEqual(JSON.parse(await protectedView.getByLabel("조회 원본", { exact: true }).innerText()), protectedResult.result);
  assert.deepEqual(JSON.parse(await protectedView.getByLabel("조회 근거", { exact: true }).innerText()), protectedResult.evidence);
  assert.equal(await panel.locator(".agent-action").count(), 0, "protected query data must not become operation cards");
  await capture("protected-result");
  await send("업무");
  assert.equal(calls.at(-1).body.agent_mode, true, "first-party panel must request agent mode");
  assert.equal(calls.at(-1).body.knowledge_mode, "personal", "new panel must bind its default personal mode");
  assert.ok(calls.at(-1).key, "agent turn must carry a stable key");
  assert.equal("vault_mode" in calls.at(-1).body, false, "knowledge_mode is the sole agent-mode scope authority");
  const card = panel.getByRole("region", { name: "작업: 업무", exact: true });
  await card.waitFor();
  await capture("preview");
  assert.equal(calls.filter(call => call.method === "POST" && call.path.includes("/operations/")).length, 0);
  await card.getByRole("button", { name: "검토", exact: true }).click();
  await card.getByLabel("내용을 검토했습니다").check();
  await capture("review");
  await card.getByRole("button", { name: "작업 확인", exact: true }).click();
  await card.getByRole("button", { name: "실행 검토", exact: true }).click();
  await card.getByRole("button", { name: "지금 실행", exact: true }).click();
  await card.getByText("실행 완료", { exact: true }).waitFor();
  await capture("executed");
  assert.equal(calls.filter(call => call.path.endsWith("/execute")).length, 1);
  assert.ok(calls.find(call => call.path.endsWith("/execute")).key);
  assert.ok(calls.some(call => decodeURIComponent(call.path).endsWith("/operations/업무") && call.method === "GET"));
  async function reviewed(name) {
    await send(name);
    const next = panel.getByRole("region", { name: `작업: ${name}`, exact: true });
    await next.getByRole("button", { name: "검토", exact: true }).click();
    await next.getByLabel("내용을 검토했습니다").check();
    return next;
  }
  const high = await reviewed("고위험");
  assert.equal(await high.getByRole("button", { name: "작업 확인", exact: true }).isEnabled(), false);
  assert.equal(await high.getByLabel("승인자", { exact: true }).inputValue(), "");
  await high.getByLabel("승인자", { exact: true }).selectOption("approver-1");
  await high.getByRole("button", { name: "작업 확인", exact: true }).click();
  await high.locator('[data-operation-status="confirmed"]').waitFor();
  assert.equal(calls.findLast(call => call.path.endsWith("/confirm")).body.approver_id, "approver-1");
  assert.equal(await high.getByRole("button", { name: "실행 검토", exact: true }).count(), 0);
  await capture("approval-pending");
  await panel.getByRole("button", { name: "결재 대기 항목 보기", exact: true }).click();
  await panel.getByRole("button", { name: "고위험 결재 승인", exact: true }).click();
  await panel.getByRole("button", { name: "결정 전송", exact: true }).click();
  await panel.getByRole("region", { name: "결재 결정 확인" }).waitFor({ state: "hidden" });
  await high.getByRole("button", { name: "상태 새로고침", exact: true }).click();
  await high.getByRole("button", { name: "실행 검토", exact: true }).click();
  await high.getByLabel("실행 재인증 비밀번호").fill("fixture-only-password");
  await high.getByRole("button", { name: "검토 닫기", exact: true }).click();
  await high.getByRole("button", { name: "실행 검토", exact: true }).click();
  assert.equal(await high.getByLabel("실행 재인증 비밀번호").inputValue(), "");
  await high.getByLabel("실행 재인증 비밀번호").fill("fixture-only-password");
  await capture("reauth");
  await high.getByRole("button", { name: "지금 실행", exact: true }).click();
  await high.locator('[data-operation-status="executed"]').waitFor();
  assert.equal(calls.findLast(call => call.path.endsWith("/execute")).body.reauth_password, "fixture-only-password");
  assert.equal(calls.filter(call => !call.path.endsWith("/execute")).some(call => JSON.stringify(call.body).includes("fixture-only-password")), false);
  for (const name of ["유실", "실행 재시도"]) {
    const recovery = await reviewed(name);
    await recovery.getByRole("button", { name: "작업 확인", exact: true }).click();
    await recovery.getByRole("button", { name: "실행 검토", exact: true }).click();
    await recovery.getByRole("button", { name: "지금 실행", exact: true }).click();
    await recovery.getByRole("button", { name: "결과 확인", exact: true }).click();
    if (name === "실행 재시도") {
      await recovery.getByRole("button", { name: "같은 요청 재시도", exact: true }).click();
      const retried = page.waitForResponse(response => response.request().method() === "POST"
        && decodeURIComponent(new URL(response.url()).pathname).endsWith(`/operations/${name}/execute`));
      await recovery.getByRole("button", { name: "지금 실행", exact: true }).click();
      await retried;
      const attempts = calls.filter(call => decodeURIComponent(call.path).endsWith(`/operations/${name}/execute`));
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].key, attempts[1].key);
      assert.deepEqual(attempts[0].body, attempts[1].body);
    }
    await recovery.locator('[data-operation-status="executed"]').waitFor();
    await capture(name === "유실" ? "receipt-recovered" : "retry-executed");
  }
  const stale = await reviewed("변경 충돌");
  operations.get("변경 충돌").version += 1;
  await stale.getByRole("button", { name: "작업 확인", exact: true }).click();
  await stale.getByRole("alert").waitFor();
  assert.equal(operations.get("변경 충돌").status, "preview");
  await capture("stale");
  await stale.getByRole("button", { name: "검토", exact: true }).click();
  await stale.getByRole("button", { name: "검토 닫기", exact: true }).click();
  await stale.getByRole("button", { name: "작업 취소", exact: true }).click();
  await stale.locator('[data-operation-status="cancelled"]').waitFor();
  await capture("cancelled");
  const executionConflict = await reviewed("실행 충돌");
  await executionConflict.getByRole("button", { name: "작업 확인", exact: true }).click();
  await executionConflict.getByRole("button", { name: "실행 검토", exact: true }).click();
  await executionConflict.getByRole("button", { name: "지금 실행", exact: true }).waitFor();
  operations.get("실행 충돌").version += 1;
  await executionConflict.getByRole("button", { name: "지금 실행", exact: true }).click();
  await executionConflict.getByRole("alert").waitFor();
  assert.equal(operations.get("실행 충돌").status, "confirmed");
  await executionConflict.getByRole("button", { name: "실행 검토", exact: true }).click();
  await executionConflict.getByRole("button", { name: "지금 실행", exact: true }).click();
  await executionConflict.locator('[data-operation-status="executed"]').waitFor();
  const revoked = await reviewed("권한 회수");
  operations.delete("권한 회수");
  await revoked.getByRole("button", { name: "작업 확인", exact: true }).click();
  await panel.getByRole("region", { name: "작업 접근 불가" }).waitFor();
  await capture("revoked");
  await send("재시도");
  await panel.getByRole("button", { name: "같은 대화 요청 재시도", exact: true }).click();
  await panel.getByRole("region", { name: "작업: 재시도", exact: true }).waitFor();
  const turns = calls.filter(call => call.body?.message === "재시도");
  assert.equal(turns.length, 2); assert.equal(turns[0].key, turns[1].key); assert.deepEqual(turns[0].body, turns[1].body);
  const before = await panel.locator(".agent-action").count();
  await send("문장만");
  await panel.getByRole("button", { name: "전송", exact: true }).waitFor();
  assert.equal(await panel.locator(".agent-action").count(), before, "prose cannot create an action card");
  const heldEntered = once(fixture, "held", { signal: AbortSignal.timeout(5000) });
  await panel.getByLabel("Agent에게 요청").fill("이전 범위");
  await panel.getByRole("button", { name: "전송", exact: true }).click();
  await heldEntered;
  await panel.getByRole("button", { name: "Agent 패널 닫기" }).click();
  await page.getByRole("button", { name: "회사 전환", exact: true }).click();
  await page.getByRole("button", { name: "AI Agent", exact: true }).click();
  releaseHeld.resolve();
  assert.equal(await panel.locator(".agent-action").count(), 0);
  await send("새 회사");
  await panel.getByRole("region", { name: "작업: 새 회사", exact: true }).waitFor();
  assert.ok(calls.findLast(call => call.path.endsWith("/chat")).path.includes("/pg/agent/"));
  assert.equal(await panel.getByRole("region", { name: "작업: 이전 범위", exact: true }).count(), 0);
  await panel.getByRole("button", { name: "Agent 패널 닫기" }).click();
  await page.getByRole("button", { name: "계정 전환", exact: true }).click();
  await page.getByRole("button", { name: "AI Agent", exact: true }).click();
  assert.equal(await panel.locator(".agent-action").count(), 0);
  await panel.getByLabel("지식 범위", { exact: true }).selectOption("company");
  assert.equal(await panel.getByRole("button", { name: "AI 기억 관리", exact: true }).count(), 0);
  const memoryReads = calls.filter(call => call.path.endsWith("/memory")).length;
  await panel.getByLabel("Agent에게 요청").fill("AI 기억 보여줘");
  await panel.getByRole("button", { name: "전송", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(calls.filter(call => call.path.endsWith("/memory")).length, memoryReads);
  await send("회사 업무");
  await panel.getByRole("region", { name: "작업: 회사 업무", exact: true }).waitFor();
  const companyTurn = calls.findLast(call => call.path.endsWith("/chat"));
  assert.equal(companyTurn.body.knowledge_mode, "company");
  assert.equal(companyTurn.body.conversation_id, null);
  await panel.getByRole("region", { name: "작업: 회사 업무", exact: true }).getByRole("button", { name: "검토", exact: true }).click();
  await panel.getByLabel("내용을 검토했습니다").waitFor();
  assert.equal(calls.findLast(call => call.path.includes("/operations/")).query.knowledge_mode, "company");
  await panel.getByLabel("지식 범위", { exact: true }).selectOption("personal");
  assert.equal(await panel.locator(".agent-action").count(), 0);
  await capture("scope-cleared");
  assert.deepEqual(errors, []);
  console.log(`INAPP_AGENT_UI_PASS width=${width} insecure=${insecure} scenarios=proposal,review,confirm,execute,approver,approval,reauth,receipt,retry,stale,cancel,revoke,chat-retry,prose,scope`);
} finally {
  releaseHeld.resolve();
  await browser?.close();
  await vite?.close();
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
