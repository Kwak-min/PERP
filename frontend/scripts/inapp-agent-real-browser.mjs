import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { preview } from "vite";

export async function exerciseRealAgentPanel({ apiOrigin, session, source, taskCount, companyFact, personalFact, knowledgeExists }) {
  const frontend = fileURLToPath(new URL("../", import.meta.url));
  const hostname = "inapp-agent.test";
  const web = await preview({ configFile: false, root: frontend,
    preview: { host: "127.0.0.1", port: 0, allowedHosts: [hostname], proxy: { "/api": apiOrigin } } });
  let browser;
  const captures = [];
  try {
    browser = await chromium.launch({ channel: "chrome",
      args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--no-proxy-server"] });
    for (const width of [375, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(value => localStorage.setItem("orbitflow.session.v1", JSON.stringify(value)), session);
      await page.goto(`http://${hostname}:${web.httpServer.address().port}/projects`);
      assert.deepEqual(await page.evaluate(() => ({
        secure: isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues,
      })), { secure: false, randomUUID: "undefined", getRandomValues: "function" });
      await page.getByRole("button", { name: "AI Agent", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "AI Agent" });
      await panel.getByLabel("지식 범위").selectOption("company");
      const directory = fileURLToPath(new URL(`../../.omo/inapp-agent/real-browser/insecure/${source}/${width}/`, import.meta.url));
      await mkdir(directory, { recursive: true });
      async function capture(name) {
        const path = `${directory}${name}.png`;
        await page.screenshot({ path, animations: "disabled" });
        const bounds = await panel.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        captures.push(path);
      }
      async function send(message, status = 200) {
        const received = page.waitForResponse(response => response.url().endsWith("/chat") && response.request().method() === "POST");
        await panel.getByLabel("Agent에게 요청").fill(message);
        await panel.getByRole("button", { name: "전송", exact: true }).click();
        const response = await received;
        const body = await response.json();
        assert.equal(response.status(), status, JSON.stringify(body));
        if (status === 200) assert.equal(typeof body.run_id, "string");
        return body;
      }
      const queried = await send("BROWSER_QUERY");
      assert.ok(JSON.stringify(queried.protected_results.length ? queried.protected_results : queried.answer).includes("INAPP_"), JSON.stringify(queried));
      await panel.getByText(queried.answer.conclusion, { exact: true }).waitFor();
      if (queried.protected_results.length) {
        const protectedResult = panel.locator("[data-protected-result]").first();
        await protectedResult.getByText("조회 결과와 근거", { exact: true }).click();
        assert.ok((await protectedResult.getByLabel("조회 원본", { exact: true }).textContent()).includes("INAPP_"));
        await protectedResult.scrollIntoViewIfNeeded();
      }
      await capture("query");
      const title = `INAPP_BROWSER_${source}_${width}`;
      const before = await taskCount(title);
      const proposed = await send(`BROWSER_PROPOSE:${title}`);
      assert.equal(proposed.actions.length, 1);
      assert.equal(await taskCount(title), before);
      const card = panel.getByRole("region", { name: `작업: ${title}`, exact: true });
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await capture("preview");
      await card.getByRole("button", { name: "검토", exact: true }).click();
      await card.getByLabel("내용을 검토했습니다").check();
      await capture("review");
      await card.getByRole("button", { name: "작업 확인", exact: true }).click();
      await card.getByRole("button", { name: "실행 검토", exact: true }).click();
      const executedResponse = page.waitForResponse(response => response.url().endsWith("/execute"));
      await card.getByRole("button", { name: "지금 실행", exact: true }).click();
      const executed = await executedResponse;
      assert.equal(executed.status(), 200, JSON.stringify(await executed.json()));
      await card.locator('[data-operation-status="executed"]').waitFor();
      assert.equal(await taskCount(title), before + 1);
      await capture("executed");
      async function upload(fact, name) {
        const uploaded = page.waitForResponse(response => response.url().endsWith("/attachments") && response.request().method() === "POST");
        await panel.getByLabel("대화 문서 첨부", { exact: true }).setInputFiles({
          name, mimeType: "text/plain", buffer: Buffer.from(fact),
        });
        const response = await uploaded;
        assert.equal(response.status(), 201, JSON.stringify(await response.json()));
        await panel.getByLabel(`${name} 첨부 제거`).waitFor();
      }
      await upload(`${companyFact} 검증 범위: ${source}-${width}.`, "company-procedure.txt");
      await capture("company-upload");
      const companyKnowledge = await send("BROWSER_KNOWLEDGE_COMPANY");
      const companySave = companyKnowledge.knowledge_saves.find(item => item.status === "saved");
      assert.ok(companySave, JSON.stringify(companyKnowledge.knowledge_saves));
      assert.equal(companySave.scope, "company");
      assert.equal(await knowledgeExists(companySave), true);
      await panel.locator('[data-knowledge-save="saved"]').last().scrollIntoViewIfNeeded();
      await capture("company-knowledge-saved");
      await panel.getByLabel("지식 범위").selectOption("personal");
      await card.waitFor({ state: "hidden" });
      await capture("mode-cleared");
      await upload(`${personalFact} 검증 범위: ${source}-${width}.`, "personal-procedure.txt");
      const denied = await send("BROWSER_KNOWLEDGE_PERSONAL", 403);
      assert.equal(denied.error.code, "CLOUD_CONSENT_REQUIRED");
      await panel.getByRole("button", { name: "개인 자료 전송 범위 확인", exact: true }).click();
      const consent = panel.getByRole("region", { name: "대화 자료 외부 전송 확인", exact: true });
      await consent.getByRole("checkbox").check();
      await consent.scrollIntoViewIfNeeded();
      await capture("personal-consent");
      const approvedResponse = page.waitForResponse(response => response.url().endsWith("/chat") && response.request().method() === "POST");
      await consent.getByRole("button", { name: "동의한 범위로 대화 전송", exact: true }).click();
      const approved = await approvedResponse;
      const personalKnowledge = await approved.json();
      assert.equal(approved.status(), 200, JSON.stringify(personalKnowledge));
      const personalSave = personalKnowledge.knowledge_saves.find(item => item.status === "saved");
      assert.ok(personalSave, JSON.stringify(personalKnowledge.knowledge_saves));
      assert.equal(personalSave.scope, "personal");
      assert.equal(await knowledgeExists(personalSave), true);
      await panel.locator('[data-knowledge-save="saved"]').last().scrollIntoViewIfNeeded();
      await capture("personal-knowledge-saved");
      await panel.getByLabel("지식 범위").selectOption("company");
      await panel.locator('[data-knowledge-save="saved"]').waitFor({ state: "hidden" });
      assert.ok(!(await panel.textContent()).includes("NATIVE_PERSONAL_FACT_SENTINEL"));
      await capture("company-after-personal");
      assert.deepEqual(errors, []);
      await page.close();
    }
    return { source, widths: [375, 768, 1280], captures, builtPanel: true, insecureOrigin: true,
      businessWrites: 3, canonicalCompanyNotes: 3, canonicalPersonalNotes: 3 };
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => web.httpServer.close(error => error ? reject(error) : resolve()));
  }
}
