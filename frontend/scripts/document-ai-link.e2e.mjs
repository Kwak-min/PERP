import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

import { api, createOwnerOrg, startTestServer } from "../../backend/tests/http.js";
import { startEmbeddingFixture } from "../../backend/tests/vault-semantic-fixture.js";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(frontend, ".artifacts/document-ai-link");
const uploadRoot = path.join(tmpdir(), `orbitflow-document-browser-${crypto.randomUUID()}`);
await mkdir(evidence, { recursive: true });

let server, wire, vite, browser;
const requests = [];
try {
  wire = await startEmbeddingFixture();
  process.env.OLLAMA_BASE_URL = wire.baseUrl;
  process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL = "synthetic-document-browser-v1";
  process.env.ORBITFLOW_UPLOAD_DIR = uploadRoot;
  server = await startTestServer();
  const owner = await createOwnerOrg(server.baseUrl, ["documents", "agent"]);
  const me = await api(server.baseUrl, "/auth/me", owner);
  const related = await api(server.baseUrl, "/documents", {
    ...owner,
    method: "POST",
    body: { title: "Browser launch handbook", content: "SYNTH_RELATED browserlaunch" },
  });
  const unrelated = await api(server.baseUrl, "/documents", {
    ...owner,
    method: "POST",
    body: { title: "Browser lunch menu", content: "SYNTH_IRRELEVANT noodles" },
  });
  assert.equal(related.status, 201);
  assert.equal(unrelated.status, 201);

  vite = await createServer({
    configFile: false,
    root: frontend,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: { ignored: ["**/.artifacts/**", "**/dist/**"] },
      proxy: { "/api": server.baseUrl.replace("/api/v1", "") },
    },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/documents")) requests.push({ method: request.method(), url: request.url() });
  });
  const session = {
    token: owner.token,
    orgId: owner.orgId,
    name: me.body.name,
    email: me.body.email,
    mustChangePassword: false,
    organizations: me.body.organizations,
  };
  await page.addInitScript((value) => {
    localStorage.setItem("orbitflow.session.v1", JSON.stringify(value));
    localStorage.setItem("orbitflow.demoMode", "0");
    window.__documentSemanticPaint = { dashed: 0, solid: 0 };
    const prototype = CanvasRenderingContext2D.prototype;
    const stroke = prototype.stroke;
    prototype.stroke = function (...args) {
      window.__documentSemanticPaint[this.getLineDash().length > 0 ? "dashed" : "solid"] += 1;
      return stroke.apply(this, args);
    };
  }, session);

  const initial = page.waitForResponse((response) => response.url().endsWith("/api/v1/documents/graph"));
  await page.goto(`${origin}/documents/graph`);
  assert.equal((await initial).status(), 200);
  const picker = page.getByLabel("조직 문서 파일 올리기");
  await picker.waitFor();

  const uploadResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/documents/upload"));
  const analysisResponse = page.waitForResponse((response) => response.request().method() === "GET" && /\/documents\/[^/]+\/analysis\?wait=1$/.test(response.url()));
  const refreshedGraph = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith("/api/v1/documents/graph"));
  await picker.setInputFiles({
    name: "browser-launch.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Browser launch\n\nSYNTH_PARAPHRASE browserlaunch uploaded content"),
  });
  const uploadedWire = await uploadResponse;
  assert.equal(uploadedWire.status(), 201);
  const uploaded = await uploadedWire.json();
  assert.equal(uploaded.analysis.state, "pending");
  assert.equal((await analysisResponse).status(), 200);
  assert.equal((await refreshedGraph).status(), 200);
  await page.locator('[data-ai-links="1"]').waitFor();
  await page.locator('.screen-notice[role="status"]').waitFor();
  const paint = await page.evaluate(() => window.__documentSemanticPaint);
  assert.ok(paint.dashed > 0, JSON.stringify(paint));
  assert.ok(paint.solid > 0, JSON.stringify(paint));

  const graph = await api(server.baseUrl, "/documents/graph?wait=1", owner);
  const inferred = graph.body.edges.filter((edge) => edge.kind === "ai_similarity" && edge.source === uploaded.id);
  assert.equal(inferred.length, 1, JSON.stringify(graph.body.edges));
  assert.equal(inferred[0].target_id, related.body.id);
  assert.notEqual(inferred[0].target_id, unrelated.body.id);
  const detail = await api(server.baseUrl, `/documents/${uploaded.id}`, owner);
  assert.match(detail.body.content, /browserlaunch uploaded content/);
  await page.screenshot({ path: path.join(evidence, "uploaded-related-document.png"), fullPage: true, animations: "disabled" });

  const unsupportedResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/documents/upload"));
  await picker.setInputFiles({ name: "unsupported.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-local-fixture") });
  assert.equal((await unsupportedResponse).status(), 415);
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").textContent(), /UTF-8 \.md and \.txt/);
  await page.screenshot({ path: path.join(evidence, "unsupported-format.png"), fullPage: true, animations: "disabled" });

  await writeFile(path.join(evidence, "result.json"), JSON.stringify({
    browser: await browser.version(),
    source: "real isolated SQLite HTTP upload/storage/RAG/graph controllers",
    inference: "synthetic localhost Ollama-compatible embedding wire; NOT real-model semantic quality",
    supportedUpload: ["UTF-8 Markdown (.md)", "UTF-8 plain text (.txt)"],
    checks: ["browser file picker upload", "persisted extracted text", "RAG retrieval", "related semantic edge", "unrelated exclusion", "dashed AI provenance rendering", "unsupported binary rejection"],
    requests,
    inferenceCalls: wire.calls.length,
    cleanup: "Chrome, Vite, HTTP server, embedding wire, temporary SQLite and upload directory closed/removed in finally",
  }, null, 2));
  console.log("DOCUMENT_AI_LINK_BROWSER_PASS");
} finally {
  await browser?.close();
  await vite?.close();
  await server?.close();
  await wire?.close();
  await rm(uploadRoot, { recursive: true, force: true });
  delete process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL;
  delete process.env.ORBITFLOW_UPLOAD_DIR;
}
