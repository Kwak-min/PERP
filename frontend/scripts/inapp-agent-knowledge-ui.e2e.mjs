import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fixture, calls, attachmentIds, consentToken, releaseHeld } from "./inapp-agent-ui-fixture.mjs";

const frontend = fileURLToPath(new URL("../", import.meta.url));
assert.ok(process.env.DEADLINE_TEMP_ROOT, "Run through scripts/run_deadline_isolated.mjs");
let vite, browser;
try {
  const listening = once(fixture, "listening");
  fixture.listen(0, "127.0.0.1");
  await listening;
  vite = await createServer({ configFile: false, root: frontend, cacheDir: `${process.env.DEADLINE_TEMP_ROOT}/vite-cache`, plugins: [react(), { name: "knowledge-fixture",
    configureServer(server) { server.middlewares.use("/agent-fixture", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/agent-fixture", '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/inapp-agent-entry.tsx"></script></body></html>'));
    }); },
  }], server: { host: "127.0.0.1", port: 0, proxy: { "/api": `http://127.0.0.1:${fixture.address().port}` } } });
  await vite.listen();
  browser = await chromium.launch({ channel: "chrome" });
  const width = Number(process.argv.find(arg => arg.startsWith("--width="))?.split("=")[1] || 1280);
  const source = process.argv.includes("--pg") ? "pg" : "legacy";
  const evidence = fileURLToPath(new URL(`../../.omo/inapp-agent/knowledge-screenshots/${source}/${width}/`, import.meta.url));
  await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(orgId => localStorage.setItem("orbitflow.session.v1", JSON.stringify({
    token: "fixture-account", orgId, name: "테스트", email: "fixture@example.invalid",
    mustChangePassword: false, organizations: [],
  })), source === "pg" ? "pg:fixture-company" : "legacy-one");
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/agent-fixture`);
  await page.getByRole("button", { name: "AI Agent", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "AI Agent" });
  const upload = panel.getByLabel("대화 문서 첨부", { exact: true });
  assert.equal(await upload.count(), 1, "AgentPanel must expose its protected document upload");
  await upload.setInputFiles({ name: "personal.txt", mimeType: "text/plain", buffer: Buffer.from("PRIVATE_UPLOAD_SENTINEL") });
  await panel.getByText("personal.txt", { exact: true }).waitFor();
  const uploaded = calls.findLast(call => call.path.endsWith("/attachments"));
  assert.equal(uploaded.body.knowledge_mode, "personal");
  assert.equal(uploaded.path, source === "pg" ? "/api/v1/pg/agent/attachments" : "/api/v1/agent/attachments");
  assert.equal(Buffer.from(uploaded.body.content_base64, "base64").toString(), "PRIVATE_UPLOAD_SENTINEL");
  await panel.getByRole("button", { name: "personal.txt 첨부 제거", exact: true }).click();
  await panel.getByText("personal.txt", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(calls.findLast(call => call.method === "DELETE").query.knowledge_mode, "personal");
  await upload.setInputFiles({ name: "personal.txt", mimeType: "text/plain", buffer: Buffer.from("PRIVATE_UPLOAD_SENTINEL") });
  await panel.getByText("personal.txt", { exact: true }).waitFor();
  await page.screenshot({ path: `${evidence}uploaded.png`, animations: "disabled" });
  await panel.getByLabel("Agent에게 요청").fill("첨부 문서의 결정 사항을 정리해줘");
  await panel.getByRole("button", { name: "전송", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  const pinned = calls.findLast(call => call.path.endsWith("/chat"));
  assert.deepEqual(pinned.body.attachment_ids, [attachmentIds.personal]);
  await panel.getByRole("button", { name: "개인 자료 전송 범위 확인", exact: true }).click();
  const consent = panel.getByRole("region", { name: "대화 자료 외부 전송 확인" });
  await consent.waitFor();
  const previewCall = calls.findLast(call => call.path.endsWith("/consent-preview"));
  assert.equal("provider" in previewCall.body || "model" in previewCall.body, false);
  assert.equal(await consent.getByRole("checkbox").isChecked(), false);
  await page.screenshot({ path: `${evidence}consent-unchecked.png`, animations: "disabled" });
  const countBefore = calls.filter(call => call.path.endsWith("/chat")).length;
  await consent.getByRole("button", { name: "전송 승인 취소", exact: true }).click();
  assert.equal(calls.filter(call => call.path.endsWith("/chat")).length, countBefore);
  await panel.getByRole("button", { name: "개인 자료 전송 범위 확인", exact: true }).click();
  await consent.getByRole("checkbox").check();
  await page.screenshot({ path: `${evidence}consent.png`, animations: "disabled" });
  await consent.getByRole("button", { name: "동의한 범위로 대화 전송", exact: true }).click();
  const receipt = panel.locator('[data-knowledge-save="saved"]');
  await receipt.waitFor();
  assert.equal(await receipt.getByRole("link").getAttribute("href"), "/vault/saved-personal");
  const approved = calls.findLast(call => call.path.endsWith("/chat"));
  assert.equal(approved.key, pinned.key);
  assert.deepEqual(approved.body.attachment_ids, pinned.body.attachment_ids);
  assert.deepEqual(approved.body.cloud_consent, { token: consentToken, confirmed: true });
  await page.screenshot({ path: `${evidence}saved.png`, animations: "disabled" });
  await panel.getByLabel("지식 범위", { exact: true }).selectOption("company");
  assert.equal(await panel.getByText("personal.txt", { exact: true }).count(), 0);
  assert.equal(await receipt.count(), 0);
  await upload.setInputFiles({ name: "company.txt", mimeType: "text/plain", buffer: Buffer.from("COMPANY_UPLOAD_SENTINEL") });
  await panel.getByText("company.txt", { exact: true }).waitFor();
  await panel.getByLabel("Agent에게 요청").fill("회사 문서 정리");
  await panel.getByRole("button", { name: "전송", exact: true }).click();
  await receipt.waitFor();
  const company = calls.findLast(call => call.path.endsWith("/chat"));
  assert.equal(company.body.knowledge_mode, "company");
  assert.equal(company.body.conversation_id, null);
  assert.deepEqual(company.body.attachment_ids, [attachmentIds.company]);
  assert.equal("cloud_consent" in company.body, false);
  assert.equal(await receipt.getByRole("link").getAttribute("href"), "/documents/saved-company");
  await page.screenshot({ path: `${evidence}company.png`, animations: "disabled" });
  await upload.setInputFiles({ name: "unsupported.png", mimeType: "image/png", buffer: Buffer.from("unsupported") });
  await panel.getByRole("alert").waitFor();
  assert.equal(await panel.getByText("unsupported.png", { exact: true }).count(), 0);
  await page.screenshot({ path: `${evidence}unsupported.png`, animations: "disabled" });
  await upload.setInputFiles({ name: "no-text.pdf", mimeType: "application/pdf", buffer: Buffer.from("NO_TEXT") });
  await panel.getByRole("alert").waitFor();
  assert.equal(await panel.getByText("no-text.pdf", { exact: true }).count(), 0);
  await page.screenshot({ path: `${evidence}no-text.png`, animations: "disabled" });
  for (const [message, status] of [["저장 실패", "failed"], ["저장 생략", "skipped"], ["범위 오류", "mismatch"]]) {
    await upload.setInputFiles({ name: "company.txt", mimeType: "text/plain", buffer: Buffer.from("COMPANY_UPLOAD_SENTINEL") });
    await panel.getByText("company.txt", { exact: true }).waitFor();
    await panel.getByLabel("Agent에게 요청").fill(message);
    await panel.getByRole("button", { name: "전송", exact: true }).click();
    if (status === "mismatch") {
      await panel.getByRole("button", { name: "대기 요청 닫기", exact: true }).waitFor();
      assert.equal(await panel.getByText("FOREIGN_PERSONAL_SAVE", { exact: true }).count(), 0);
      await panel.getByRole("button", { name: "대기 요청 닫기", exact: true }).click();
    } else {
      await panel.locator(`[data-knowledge-save="${status}"]`).waitFor();
      assert.equal(await panel.locator(`[data-knowledge-save="${status}"]`).getByRole("link").count(), 0);
      await panel.locator(`[data-knowledge-save="${status}"]`).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}save-${status}.png`, animations: "disabled" });
    }
  }
  await panel.getByLabel("지식 범위", { exact: true }).selectOption("personal");
  const held = once(fixture, "held", { signal: AbortSignal.timeout(5000) });
  await panel.getByLabel("Agent에게 요청").fill("이전 범위");
  await panel.getByRole("button", { name: "전송", exact: true }).click();
  await held;
  await panel.getByLabel("지식 범위", { exact: true }).selectOption("company");
  releaseHeld.resolve();
  await panel.getByLabel("Agent에게 요청").fill("새 모드 확인");
  await panel.getByRole("button", { name: "전송", exact: true }).click();
  await panel.getByRole("region", { name: "작업: 새 모드 확인", exact: true }).waitFor();
  assert.equal(await panel.getByText("이전 범위", { exact: true }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "같은 대화 요청 재시도", exact: true }).count(), 0);
  await page.screenshot({ path: `${evidence}mode-cleared.png`, animations: "disabled" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(`INAPP_AGENT_KNOWLEDGE_UI_PASS source=${source} width=${width}`);
} finally {
  releaseHeld.resolve();
  await browser?.close();
  await vite?.close();
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
