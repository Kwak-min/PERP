import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

import { api } from "../../backend/tests/http.js";
import { startPgDocumentFixture } from "../../backend/tests/pg-document-fixture.js";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(frontend, ".artifacts/document-ai-link-pg");
await mkdir(evidence, { recursive: true });
delete process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL;
delete process.env.OLLAMA_BASE_URL;

let fixture, vite, browser;
const requests = [];
try {
  fixture = await startPgDocumentFixture();
  vite = await createServer({
    configFile: false,
    root: frontend,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: { ignored: ["**/.artifacts/**", "**/dist/**"] },
      proxy: { "/api": fixture.baseUrl.replace("/api/v1", "") },
    },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/") && request.url().includes("documents")) {
      requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  await page.addInitScript((actor) => {
    localStorage.setItem("orbitflow.session.v1", JSON.stringify({
      token: actor.token,
      orgId: actor.orgId,
      name: "문서 작성자",
      email: "writer@example.invalid",
      mustChangePassword: false,
      organizations: [{ org_id: actor.orgId, org_name: "문서 테스트 회사", org_type: "perp_db", roles: ["writer"] }],
    }));
    localStorage.setItem("orbitflow.demoMode", "0");
  }, fixture.actors.writer);

  const initial = page.waitForResponse((response) => response.url().endsWith("/api/v1/pg/documents/graph"));
  await page.goto(`${origin}/documents/graph`);
  assert.equal((await initial).status(), 200);
  const project = page.getByLabel("저장할 프로젝트");
  await project.waitFor();
  assert.equal(await project.inputValue(), "10");
  assert.match(await page.getByText(/올릴 수 있는 파일: UTF-8/).textContent(), /\.md\/\.txt, 최대 1 MB/);
  await page.getByRole("note").filter({ hasText: "AI Agent 채팅 RAG 색인에는 아직 연결되지 않습니다." }).waitFor();

  const picker = page.getByLabel("조직 문서 파일 올리기");
  const uploadResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/pg/documents/upload"));
  const refreshed = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith("/api/v1/pg/documents/graph"));
  await picker.setInputFiles({
    name: "회사-출시-안내.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 회사 출시 안내\n\npglaunch 모델 미설정 저장 확인"),
  });
  const response = await uploadResponse;
  assert.equal(response.status(), 201, await response.text());
  const uploaded = await response.json();
  assert.equal(uploaded.analysis.state, "unavailable");
  assert.equal(uploaded.analysis.reason, "model_not_configured");
  assert.equal((await refreshed).status(), 200);
  await page.getByText("회사-출시-안내.md 회사 문서 저장은 완료했습니다. 로컬 임베딩 모델을 사용할 수 없어 AI 유사 관계는 만들지 않았습니다.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("application", { name: "조직 지식 3D 그래프" }).getAttribute("data-ai-links"), "0");

  const detail = await api(fixture.baseUrl, `/pg/documents/${uploaded.id}`, fixture.actors.writer);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.content, "# 회사 출시 안내\n\npglaunch 모델 미설정 저장 확인");
  const graph = await api(fixture.baseUrl, "/pg/documents/graph", fixture.actors.writer);
  assert.ok(graph.body.nodes.some((node) => node.id === uploaded.id && node.folder === "출시 프로젝트"));
  assert.equal(graph.body.edges.filter((edge) => edge.kind === "ai_similarity").length, 0);
  assert.ok(graph.body.analysis.every((item) => item.state === "unavailable"));
  assert.ok(requests.every((entry) => entry.path.startsWith("/api/v1/pg/documents")), JSON.stringify(requests));
  await page.screenshot({ path: path.join(evidence, "pg-upload-model-unavailable.png"), fullPage: true, animations: "disabled" });

  const rejected = page.waitForResponse((candidate) => candidate.request().method() === "POST" && candidate.url().endsWith("/api/v1/pg/documents/upload"));
  await picker.setInputFiles({ name: "unsupported.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-local-only") });
  assert.equal((await rejected).status(), 415);
  await page.getByRole("alert").waitFor();
  await page.screenshot({ path: path.join(evidence, "pg-unsupported-format.png"), fullPage: true, animations: "disabled" });

  await writeFile(path.join(evidence, "result.json"), JSON.stringify({
    browser: await browser.version(),
    storage: "real PG HTTP/auth/controller contract with controlled company-scoped SQL adapter; NOT a PostgreSQL server",
    inference: "no real or synthetic model configured; product state unavailable/model_not_configured; zero AI edges",
    supportedUpload: ["UTF-8 Markdown (.md)", "UTF-8 plain text (.txt)"],
    checks: ["PG workspace source routing", "project selection", "file picker upload", "PG file/document persistence contract", "model unavailable state", "zero fabricated AI edges", "binary rejection"],
    requests,
    cleanup: "Chrome, Vite, HTTP server, temporary SQLite and upload directory closed/removed in finally",
  }, null, 2));
  console.log("PG_DOCUMENT_AI_LINK_BROWSER_PASS");
} finally {
  await browser?.close();
  await vite?.close();
  await fixture?.close();
  delete process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL;
  delete process.env.OLLAMA_BASE_URL;
}
