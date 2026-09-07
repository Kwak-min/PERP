import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { api, createOwnerOrg, startTestServer } from "../../backend/tests/http.js";
import { installPgKeyFixture } from "../../backend/tests/pg-api-key-fixture.js";

const pgMode = process.argv.includes("--pg");
const calls = [];
const keyRoutes = [];
const serverErrors = [];
let wire, backend, staticServer, browser, pgFixture;
const evidence = new URL(pgMode ? "../../.omo/api-key-pg-evidence/" : "../../.omo/api-key-evidence/", import.meta.url);
const secret = "sk-or-v1-synthetic-browser-only";
const replacement = "sk-or-v1-synthetic-browser-replacement";
try {
  wire = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { total_tokens: 2 } }));
  });
  const wireReady = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
  wire.listen(0, "127.0.0.1");
  await wireReady;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}`;
  process.env.OPENROUTER_API_KEY = "";
  process.env.ORBITFLOW_AI_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  backend = await startTestServer();
  if (pgMode) pgFixture = await installPgKeyFixture();
  const owner = pgMode ? pgFixture.actor("101") : await createOwnerOrg(backend.baseUrl, ["agent"]);
  const other = pgMode ? pgFixture.actor("102") : await createOwnerOrg(backend.baseUrl, ["agent"]);
  if (!pgMode) {
    const options = { ...owner, method: "POST" };
    await api(backend.baseUrl, "/vault/notes", { ...options, body: { title: "privacy fixture", content: "vault-context-must-not-be-sent" } });
    await api(backend.baseUrl, "/agent/memory", { ...options, body: { content: "memory-context-must-not-be-sent" } });
  }
  const { env } = await import("../../backend/src/config/env.js");
  staticServer = createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/v1/")) {
        if (req.url.includes("/agent/api-key")) keyRoutes.push(req.url);
        let body = "";
        for await (const chunk of req) body += chunk;
        const response = await fetch(`${backend.baseUrl}${req.url.slice(7)}`, {
          method: req.method, headers: { "Content-Type": "application/json", authorization: req.headers.authorization ?? "", "x-org-id": req.headers["x-org-id"] ?? "" },
          body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        });
        if (response.status === 500) serverErrors.push(req.url);
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(await response.text());
        return;
      }
      const name = extname(req.url) ? req.url.slice(1) : "index.html";
      const content = await readFile(new URL(`../dist/${name}`, import.meta.url));
      res.setHeader("Content-Type", extname(name) === ".js" ? "text/javascript" : extname(name) === ".css" ? "text/css" : "text/html");
      res.end(content);
    } catch (error) {
      if (error.code === "ENOENT") { res.writeHead(404); res.end(); }
      else { res.writeHead(500); res.end(); throw error; }
    }
  });
  const staticReady = once(staticServer, "listening", { signal: AbortSignal.timeout(5000) });
  staticServer.listen(0, "127.0.0.1");
  await staticReady;
  const appUrl = `http://127.0.0.1:${staticServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome" });
  await mkdir(evidence, { recursive: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((actor) => sessionStorage.setItem("orbitflow.session.v1", JSON.stringify({
    token: actor.token, orgId: actor.orgId, name: "Fixture", email: "fixture@example.com", mustChangePassword: false,
    organizations: [{ org_id: actor.orgId, org_name: actor.orgId.startsWith("pg:") ? "PG 회사 77" : "Test Org", org_type: actor.orgId.startsWith("pg:") ? "perp_db" : "custom", roles: ["configured"] }],
  })), owner);
  await page.goto(pgMode ? `${appUrl}/settings/ai-key` : appUrl);
  if (!pgMode) await Promise.all([
    page.waitForURL((url) => url.pathname === "/settings/ai-key", { timeout: 5000 }),
    page.getByRole("navigation", { name: "주 메뉴", exact: true }).getByRole("link", { name: "AI API 키", exact: true }).click(),
  ]);
  const status = page.getByTestId("api-key-status");
  await expect(status).toHaveAttribute("data-configured", "false", { timeout: 5000 });
  const input = page.getByLabel("OpenRouter API 키", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  const action = async (method, button, suffix = "") => {
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/agent/api-key${suffix}`) && response.request().method() === method, { timeout: 15000 }),
      button.click(),
    ]);
    return response;
  };
  await input.fill(secret);
  assert.equal((await action("PUT", page.getByRole("button", { name: "키 저장", exact: true }))).status(), 200);
  await expect(status).toHaveAttribute("data-configured", "true");
  await expect(input).toHaveValue("");
  assert.equal((await action("POST", page.getByRole("button", { name: "연결 테스트", exact: true }), "/test")).status(), 200);
  assert.equal(calls.at(-1).authorization, `Bearer ${secret}`);
  assert.ok(!JSON.stringify(calls).includes("vault-context-must-not-be-sent"));
  assert.ok(!JSON.stringify(calls).includes("memory-context-must-not-be-sent"));
  await input.fill(replacement);
  assert.equal((await action("PUT", page.getByRole("button", { name: "키 교체", exact: true }))).status(), 200);
  await action("POST", page.getByRole("button", { name: "연결 테스트", exact: true }), "/test");
  assert.equal(calls.at(-1).authorization, `Bearer ${replacement}`);
  await page.reload();
  await expect(status).toHaveAttribute("data-configured", "true");
  await expect(input).toHaveValue("");
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!storage.includes(secret) && !storage.includes(replacement));
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(status).toBeVisible();
    assert.equal((await action("POST", page.getByRole("button", { name: "연결 테스트", exact: true }), "/test")).status(), 200);
    await page.locator(".sidebar").evaluate(async (sidebar) => {
      const timeout = AbortSignal.timeout(5000);
      await Promise.race([
        Promise.all(sidebar.getAnimations().map((animation) => animation.finished)),
        new Promise((_, reject) => timeout.addEventListener("abort", () => reject(timeout.reason), { once: true })),
      ]);
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `overflow at ${width}`);
    await page.screenshot({ path: fileURLToPath(new URL(`configured-${width}.png`, evidence)), fullPage: true });
  }
  const isolated = await browser.newContext();
  const otherPage = await isolated.newPage();
  await otherPage.addInitScript((actor) => sessionStorage.setItem("orbitflow.session.v1", JSON.stringify({
    token: actor.token, orgId: actor.orgId, name: "Other", email: "other@example.com", mustChangePassword: false,
    organizations: [{ org_id: actor.orgId, org_name: "Other Org", org_type: "custom", roles: ["owner"] }],
  })), other);
  await otherPage.goto(`${appUrl}/settings/ai-key`);
  await expect(otherPage.getByTestId("api-key-status")).toHaveAttribute("data-configured", "false");
  await isolated.close();
  const master = env.aiKeyEncryptionKey;
  env.aiKeyEncryptionKey = "";
  try {
    await input.fill(secret);
    assert.equal((await action("PUT", page.getByRole("button", { name: "키 교체", exact: true }))).status(), 503);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(input).toHaveValue("");
    await page.screenshot({ path: fileURLToPath(new URL("configuration-error.png", evidence)), fullPage: true });
  } finally { env.aiKeyEncryptionKey = master; }
  await page.getByRole("button", { name: "키 삭제", exact: true }).click();
  assert.equal((await action("DELETE", page.getByRole("button", { name: "삭제 확인", exact: true }))).status(), 200);
  await expect(status).toHaveAttribute("data-configured", "false");
  await expect(page.getByRole("button", { name: "연결 테스트", exact: true })).toBeDisabled();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(serverErrors, []);
  assert.ok(keyRoutes.length > 0 && keyRoutes.every(path => path.startsWith(pgMode ? "/api/v1/pg/agent/api-key" : "/api/v1/agent/api-key")));
  console.log(`${pgMode ? "PG_" : ""}API_KEY_CHROME_PASS save replace reload synthetic-use isolation config-error delete 375/768/1280`);
  await context.close();
} finally {
  if (browser) await browser.close();
  if (staticServer) await new Promise((resolve, reject) => staticServer.close((error) => error ? reject(error) : resolve()));
  if (pgFixture) await pgFixture.close();
  if (backend) await backend.close();
  if (wire) await new Promise((resolve, reject) => wire.close((error) => error ? reject(error) : resolve()));
}
