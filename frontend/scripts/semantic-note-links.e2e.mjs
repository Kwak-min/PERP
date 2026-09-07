import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { api, createOwnerOrg, startTestServer } from "../../backend/tests/http.js";
import { startEmbeddingFixture } from "../../backend/tests/vault-semantic-fixture.js";
import { startPgGraphFixture } from "./graph-pg-fixture.mjs";
const pg = process.env.SEMANTIC_QA_PG === "1";
const frontend = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(frontend, ".artifacts/semantic-note-links", pg ? "pg" : "sqlite");
let wire, server, vite, browser;
const requests = [], errors = [];
try {
  wire = await startEmbeddingFixture();
  process.env.OLLAMA_BASE_URL = wire.baseUrl;
  process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL = "synthetic-wire-v1";
  server = await (pg ? startPgGraphFixture() : startTestServer());
  const owner = pg ? server : await createOwnerOrg(server.baseUrl, ["agent"]);
  if (pg) server.notes.clear();
  const base = pg ? "/pg/vault" : "/vault";
  const req = (suffix, options = {}) => api(server.baseUrl, `${base}${suffix}`, { ...owner, ...options });
  const create = async (title, content) => {
    const r = await req("/notes", { method: "POST", body: { title, content } }); assert.equal(r.status, 201);
    await req(`/notes/${r.body.id}/analysis?wait=1`); return r.body;
  };
  const a = await create("Semantic A", "SYNTH_RELATED");
  const unrelated = await create("Unrelated", "SYNTH_IRRELEVANT");
  vite = await createServer({ configFile: false, root: frontend, plugins: [react()], server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.artifacts/**", "**/dist/**"] }, proxy: { "/api": server.baseUrl.replace("/api/v1", "") } } });
  await vite.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  const me = pg ? null : await api(server.baseUrl, "/auth/me", owner);
  const session = { token: owner.token, orgId: owner.orgId, name: "Synthetic QA", email: "qa@example.invalid", mustChangePassword: false,
    organizations: pg ? [{ org_id: owner.orgId, org_name: "PG QA Workspace", org_type: "perp_db", roles: ["member"] }] : me.body.organizations };
  await page.addInitScript(value => {
    localStorage.setItem("orbitflow.session.v1", JSON.stringify(value));
    window.__semanticPaint = { dashed: 0, solid: 0 };
    const proto = CanvasRenderingContext2D.prototype, stroke = proto.stroke;
    proto.stroke = function (...args) { window.__semanticPaint[this.getLineDash().length ? "dashed" : "solid"]++; return stroke.apply(this, args); };
  }, session);
  page.on("request", r => { if (r.url().includes("/api/v1/")) requests.push({ method: r.method(), path: new URL(r.url()).pathname }); });
  page.on("pageerror", e => errors.push(String(e)));
  const response = (suffix, method = "GET") => page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${base}${suffix}` && r.request().method() === method);
  // 정확한 DOM 상태를 동작 전에 구독. sleep/주기적 검사 없음.
  async function arm(selector) {
    await page.evaluate(selector => {
      window.__semanticSignal = new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => { if (document.querySelector(selector)) { observer.disconnect(); clearTimeout(timer); resolve(); } });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM signal: ${selector}`)); }, 10000);
        observer.observe(document, { subtree: true, attributes: true, childList: true });
      });
    }, selector);
  }
  const signal = () => page.evaluate(() => window.__semanticSignal);
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.goto(`${origin}/vault`);
  await page.getByLabel("제목", { exact: true }).fill("Semantic B");
  await page.getByLabel("본문 마크다운").fill("SYNTH_PARAPHRASE [[Unrelated]]");
  await arm('[data-analysis-state="ready"]'); const created = response("/notes", "POST");
  await page.getByRole("button", { name: "노트 만들기", exact: true }).click();
  const saved = await created; assert.equal(saved.status(), 201); const b = await saved.json(); await signal();
  const graphResponse = response("/graph"); await page.goto(`${origin}/vault/graph`);
  const graph = await (await graphResponse).json();
  assert.ok(graph.edges.some(e => e.kind === "ai_similarity" && new Set([e.source, e.target_id]).has(b.id)));
  await page.getByRole("application", { name: "개인 노트 3D 그래프" }).waitFor();
  await arm(`.graph-editor[data-note-id="${b.id}"]`); await page.getByLabel("그래프 노트 선택").selectOption(b.id); await signal();
  assert.equal(await page.locator('[data-edge-kind="ai_similarity"]').count(), 1);
  assert.equal(await page.locator('[data-edge-kind="manual"]').count(), 1);
  assert.ok((await page.evaluate(() => window.__semanticPaint)).dashed > 0);
  assert.ok((await page.evaluate(() => window.__semanticPaint)).solid > 0);
  await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, "linked.png"), fullPage: true });
  await page.getByLabel("본문 마크다운").fill("SYNTH_IRRELEVANT [[Unrelated]]");
  const inferenceGate = Promise.withResolvers(); wire.gate = inferenceGate.promise;
  const entered = once(wire.server, "inference", { signal: AbortSignal.timeout(10000) });
  try {
    await arm('body:has([data-analysis-state="pending"]):has(.graph-editor:not([disabled]))');
    const patched = response(`/notes/${b.id}`, "PATCH");
    await page.getByRole("button", { name: "변경 저장", exact: true }).click(); assert.equal((await patched).status(), 200); await entered; await signal();
    assert.equal(await page.getByLabel("본문 마크다운").isEnabled(), true, "saved note editor must not wait for inference");
    await arm(`[data-edge-kind="ai_similarity"][data-related-note-id="${unrelated.id}"]`);
    inferenceGate.resolve(); wire.gate = null; await signal();
  } finally { inferenceGate.resolve(); wire.gate = null; }
  const changed = (await req("/graph")).body.edges.filter(e => e.kind === "ai_similarity");
  assert.equal(changed.length, 1); assert.deepEqual(new Set([changed[0].source, changed[0].target_id]), new Set([b.id, unrelated.id]));
  assert.ok(!changed.some(e => e.source === a.id || e.target_id === a.id));
  wire.mode = "error";
  await page.getByLabel("본문 마크다운").fill("SYNTH_PARAPHRASE failure-version");
  await arm('body:has([data-analysis-state="error"]):has(canvas[data-layout="settled"][data-ai-links="0"])'); await page.getByRole("button", { name: "변경 저장", exact: true }).click(); await signal();
  assert.ok(!(await req("/graph")).body.edges.some(e => e.kind === "ai_similarity" && (e.source === b.id || e.target_id === b.id)));
  wire.mode = "ok";
  await arm('body:has([data-analysis-state="ready"]):has(canvas[data-layout="settled"][data-ai-links="1"])'); await page.getByRole("button", { name: "AI 연결 다시 분석", exact: true }).click(); await signal();
  await page.screenshot({ path: path.join(evidence, "retry-ready.png"), fullPage: true });
  delete process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL;
  await page.getByLabel("본문 마크다운").fill("SYNTH_PARAPHRASE unconfigured-version");
  await arm('body:has([data-analysis-state="unavailable"]):has(canvas[data-layout="settled"][data-ai-links="0"])');
  await page.getByRole("button", { name: "변경 저장", exact: true }).click(); await signal();
  await page.screenshot({ path: path.join(evidence, "unavailable.png"), fullPage: true });
  await arm(`select[aria-label="그래프 노트 선택"]:not(:has(option[value="${b.id}"]))`);
  const deleted = response(`/notes/${b.id}`, "DELETE"); await page.getByRole("button", { name: "삭제", exact: true }).click(); await deleted; await signal();
  assert.ok(!(await req("/graph")).body.edges.some(e => e.source === b.id || e.target_id === b.id));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  if (pg) assert.ok(!requests.some(r => r.path.startsWith("/api/v1/vault")));
  else assert.ok(!requests.some(r => r.path.startsWith("/api/v1/pg/vault")));
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ source: pg ? "real PG controllers + SQL contract fixture (not real PG)" : "real isolated SQLite HTTP", surface: "real SPA in Chrome", inference: "synthetic local Ollama embedding wire, NOT model semantic quality", requests, errors, inferenceCalls: wire.calls.length, checks: ["create automatic link", "manual/AI edge rendering", "nonblocking editor during gated inference", "version changes graph", "error no fake edges", "retry", "unconfigured model status", "delete invalidation", "exact source routing"], cleanup: "Chrome/Vite/HTTP/wire/temp DB closed in finally" }, null, 2));
  console.log(`SEMANTIC_BROWSER_${pg ? "PG" : "SQLITE"}_PASS`);
} finally { await browser?.close(); await vite?.close(); await server?.close(); await wire?.close(); }
