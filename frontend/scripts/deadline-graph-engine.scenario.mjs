import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

import { networkAudit, protectedPorts } from "../../scripts/deadline-isolation-guard.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = path.join(root, ".omo/evidence/task-27-deadline-erp-redesign");
const screenshotDir = path.join(evidence, "screens");

export async function graphEngineScenario() {
  const runId = randomUUID();
  await mkdir(screenshotDir, { recursive: true });
  const result = { runId, status: "running", chrome: null, cases: [], requests: [], cleanup: {}, source: "authorized synthetic graph / actual KnowledgeGraphStage" };
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  result.provenance = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    packages: {
      "3d-force-graph": lock.packages["node_modules/3d-force-graph"],
      three: lock.packages["node_modules/three"],
    },
    hashes: {},
  };
  for (const file of ["frontend/src/components/data/KnowledgeGraphStage.tsx", "frontend/src/components/data/useKnowledgeGraphEngine.ts", "frontend/src/components/data/knowledgeGraphStageModel.ts", "frontend/src/components/data/knowledge-graph-stage.css", "frontend/THIRD_PARTY_NOTICES.md", "frontend/package.json", "package-lock.json"]) {
    result.provenance.hashes[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  let vite, browserServer, browser;
  try {
    vite = await createServer({
      configFile: false,
      root: path.join(root, "frontend"),
      envDir: process.env.DEADLINE_TEMP_ROOT,
      cacheDir: path.join(process.env.DEADLINE_TEMP_ROOT, "vite-graph-engine"),
      plugins: [
        {
          name: "task-27-fixture",
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__task27") { next(); return; }
              const source = '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Task 27 Graph</title></head><body><div id="root"></div><script type="module" src="/scripts/knowledge-graph-stage-entry.tsx"></script></body></html>';
              response.setHeader("Content-Type", "text/html; charset=utf-8");
              response.end(await server.transformIndexHtml(request.url, source));
            });
          },
        },
        react(),
      ],
      server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.omo/**", "**/dist/**"] } },
    });
    await vite.listen();
    const port = vite.httpServer.address().port;
    assert.ok(!protectedPorts.has(port));
    const origin = `http://127.0.0.1:${port}`;
    browserServer = await chromium.launchServer({ channel: "chrome", headless: true, args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"] });
    browser = await chromium.connect(browserServer.wsEndpoint());
    result.chrome = browser.version();

    const open = async (options = {}) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: options.reducedMotion ?? "no-preference", serviceWorkers: "block" });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !protectedPorts.has(Number(url.port))) {
          result.requests.push({ url: url.href, method: route.request().method() });
          return route.continue();
        }
        result.requests.push({ url: url.href, method: route.request().method(), blocked: true });
        return route.abort("blockedbyclient");
      });
      await context.addInitScript(runtimeInstrumentation);
      if (options.webglFailure) await context.addInitScript(disableWebGl);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (error) => { errors.push(error.message); console.error(`TASK27_PAGE_ERROR ${error.message}`); });
      return { context, page, errors };
    };

    const happy = await open();
    try {
      await happy.page.goto(`${origin}/__task27`, { waitUntil: "domcontentloaded" });
      await waitStage(happy.page, "ready");
      await armStage(happy.page, { render: "idle" });
      await happy.page.getByRole("button", { name: "자동 회전 끄기" }).click();
      await stageSignal(happy.page);
      const before = await happy.page.locator(".knowledge-graph-stage__viewport").screenshot({ animations: "disabled" });
      await happy.page.getByRole("button", { name: "왼쪽으로 회전" }).click();
      const rotated = await happy.page.locator(".knowledge-graph-stage__viewport").screenshot({ animations: "disabled" });
      assert.notEqual(createHash("sha256").update(rotated).digest("hex"), createHash("sha256").update(before).digest("hex"));
      await happy.page.getByRole("button", { name: "확대", exact: true }).click();
      const zoomed = await happy.page.locator(".knowledge-graph-stage__viewport").screenshot({ animations: "disabled" });
      assert.notEqual(createHash("sha256").update(zoomed).digest("hex"), createHash("sha256").update(rotated).digest("hex"));
      const canvas = await happy.page.locator(".knowledge-graph-stage__webgl canvas").boundingBox();
      assert.ok(canvas);
      await armSelected(happy.page);
      await happy.page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
      await happy.page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
      await selectedSignal(happy.page);
      assert.notEqual(await happy.page.getByTestId("selected-node").textContent(), "");
      assert.equal(await happy.page.evaluate(() => window.__task27Unchanged()), true);
      assert.equal(await happy.page.locator("img, script:not([type=module])").count(), 0);
      assert.equal(await happy.page.evaluate(() => window.__unsafeExecuted), false);
      await happy.page.screenshot({ path: path.join(screenshotDir, "one-node-controls.png"), fullPage: true, animations: "disabled" });
      result.cases.push({ name: "one-node-controls", rotate: true, zoom: true, canvasPick: true, sourceUnchanged: true, safeText: true });

      await armStage(happy.page, { state: "empty" });
      await happy.page.getByRole("button", { name: "0개 노드", exact: true }).click();
      await stageSignal(happy.page);
      assert.equal(await happy.page.locator(".knowledge-graph-stage__webgl canvas").count(), 0);
      assert.equal(await happy.page.getByText("표시할 수 있는 지식 노드가 없습니다.").count(), 2);
      result.cases.push({ name: "zero-nodes", engineCreated: false, semanticEmptyState: true });

      await armStage(happy.page, { state: "ready" });
      await happy.page.getByRole("button", { name: "1000개 노드", exact: true }).click();
      await stageSignal(happy.page);
      const keyboardNodes = happy.page.locator(".knowledge-graph-stage__nodes button");
      assert.equal(await keyboardNodes.count(), 1000);
      await keyboardNodes.first().focus();
      await keyboardNodes.first().press("ArrowDown");
      assert.equal(await keyboardNodes.nth(1).evaluate(node => node === document.activeElement), true);
      await keyboardNodes.nth(1).press("End");
      assert.equal(await keyboardNodes.last().evaluate(node => node === document.activeElement), true);
      await keyboardNodes.last().press("Home");
      await keyboardNodes.first().press("Enter");
      assert.equal(await keyboardNodes.first().getAttribute("aria-pressed"), "true");
      assert.equal(await happy.page.getByTestId("selected-node").textContent(), await happy.page.evaluate(() => window.__task27Source.nodes[0].renderer_id));
      result.cases.push({ name: "keyboard-focus-selection", arrows: true, homeEnd: true, enterSelectsExactIdentity: true });
      await happy.page.getByText(/연결 1001개/).click();
      assert.deepEqual((await happy.page.locator(".knowledge-graph-stage__edges li").evaluateAll((items) => items.slice(0, 3).map((item) => ({ relation: item.getAttribute("data-relation"), text: item.textContent })))).map((item) => item.relation), ["wiki", "wiki", "ai"]);
      assert.equal(await happy.page.evaluate(() => window.__task27Unchanged()), true);
      await happy.page.screenshot({ path: path.join(screenshotDir, "thousand-nodes.png"), fullPage: true, animations: "disabled" });
      result.cases.push({ name: "thousand-nodes", nodes: 1000, links: 1001, reciprocalAndParallel: true, sourceUnchangedAfterSimulation: true });

      await armStage(happy.page, { state: "ready", nextCanvas: true });
      await happy.page.getByRole("button", { name: "1개 노드", exact: true }).click();
      await stageSignal(happy.page);
      for (let transition = 0; transition < 10; transition += 1) {
        await armStage(happy.page, { absent: true });
        await happy.page.getByRole("button", { name: "그래프 해제" }).click();
        await stageSignal(happy.page);
        await happy.page.evaluate(() => window.__task27Runtime.idle());
        const released = await happy.page.evaluate(() => window.__task27Runtime.snapshot());
        assert.equal(released.observers, 0);
        assert.equal(released.pendingRaf, 0);
        assert.equal(released.contextsCreated, released.contextsLost);
        await armStage(happy.page, { state: "ready" });
        await happy.page.getByRole("button", { name: "그래프 장착" }).click();
        await stageSignal(happy.page);
      }
      await armStage(happy.page, { absent: true });
      await happy.page.getByRole("button", { name: "그래프 해제" }).click();
      await stageSignal(happy.page);
      await happy.page.evaluate(() => window.__task27Runtime.idle());
      const cleanup = await happy.page.evaluate(() => window.__task27Runtime.snapshot());
      assert.deepEqual(happy.errors, []);
      result.cases.push({ name: "ten-route-transitions", transitions: 10, cleanup });
    } finally {
      await happy.context.close();
    }

    const reduced = await open({ reducedMotion: "reduce" });
    try {
      await reduced.page.goto(`${origin}/__task27`, { waitUntil: "domcontentloaded" });
      await waitStage(reduced.page, "ready", "idle");
      assert.equal(await reduced.page.getByRole("button", { name: "자동 회전" }).isDisabled(), true);
      assert.equal((await reduced.page.evaluate(() => window.__task27Runtime.snapshot())).pendingRaf, 0);
      await armStage(reduced.page, { state: "loading", scope: "company-task-27:1" });
      await reduced.page.getByRole("button", { name: "범위 전환" }).click();
      await stageSignal(reduced.page);
      await waitStage(reduced.page, "ready", "idle");
      assert.equal(await reduced.page.evaluate(() => window.__task27Unchanged()), true);
      assert.equal(await reduced.page.locator(".knowledge-graph-stage").count(), 1);
      assert.deepEqual(reduced.errors, []);
      await reduced.page.evaluate(() => {
        const canvas = document.querySelector("canvas"), width = canvas.width;
        window.__task28Resize = new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => { if (canvas.width !== width) { clearTimeout(timer); observer.disconnect(); resolve(); } });
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error("canvas resize deadline")); }, 15000);
          observer.observe(canvas, { attributes: true, attributeFilter: ["width"] });
        });
      });
      await reduced.page.setViewportSize({ width: 375, height: 900 });
      await reduced.page.evaluate(() => window.__task28Resize);
      const resizedImage = await reduced.page.locator(".knowledge-graph-stage__viewport").screenshot({ path: path.join(screenshotDir, "reduced-resized.png"), animations: "disabled" });
      const colored = Number(execFileSync("python", ["-c", "import sys,io;from PIL import Image;im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB');print(sum(1 for r,g,b in im.get_flattened_data() if r<140 and b>150 and b>r+60))"], { input: resizedImage, timeout: 10000 }).toString().trim());
      assert.ok(colored > 100, `paused renderer must repaint its node after actual canvas resize; colored=${colored}`);
      result.cases.push({ name: "paused-resize-pixels", colored });
      await reduced.page.screenshot({ path: path.join(screenshotDir, "reduced-motion.png"), fullPage: true, animations: "disabled" });
      result.cases.push({ name: "reduced-motion", autoRotate: false, cameraTween: false, animatedLayout: false, idleRaf: 0 });
    } finally {
      await reduced.context.close();
    }

    const failure = await open({ webglFailure: true });
    try {
      await failure.page.goto(`${origin}/__task27`, { waitUntil: "domcontentloaded" });
      await waitStage(failure.page, "error", "idle");
      assert.equal(await failure.page.getByRole("alert").count(), 1);
      await failure.page.locator(".knowledge-graph-stage__nodes button").click();
      assert.notEqual(await failure.page.getByTestId("selected-node").textContent(), "");
      assert.equal(await failure.page.locator(".knowledge-graph-stage__webgl canvas").count(), 0);
      await failure.page.screenshot({ path: path.join(screenshotDir, "webgl-failure.png"), fullPage: true, animations: "disabled" });
      result.cases.push({ name: "webgl-failure", honestError: true, semanticSelection: true, fake3d: false });
    } finally {
      await failure.context.close();
    }

    const importFailure = await open();
    try {
      await importFailure.context.route("**/3d-force-graph.js*", (route) => route.abort("failed"));
      await importFailure.page.goto(`${origin}/__task27`, { waitUntil: "domcontentloaded" });
      await waitStage(importFailure.page, "error", "idle");
      await importFailure.page.locator(".knowledge-graph-stage__nodes button").click();
      assert.notEqual(await importFailure.page.getByTestId("selected-node").textContent(), "");
      assert.deepEqual(await importFailure.page.evaluate(() => window.__task27Runtime.snapshot()), { pendingRaf: 0, observers: 0, contextsCreated: 0, contextsLost: 0 });
      result.cases.push({ name: "dynamic-import-failure", honestError: true, semanticSelection: true, resourcesCreated: 0 });
    } finally {
      await importFailure.context.close();
    }

    const lateImport = await open();
    const releaseImport = Promise.withResolvers();
    let importedUrl = "";
    try {
      await lateImport.context.route("**/3d-force-graph.js*", async (route) => {
        importedUrl = route.request().url();
        await releaseImport.promise;
        await route.continue();
      });
      const importRequest = lateImport.page.waitForRequest((request) => request.url().includes("3d-force-graph.js"));
      await lateImport.page.goto(`${origin}/__task27`, { waitUntil: "domcontentloaded" });
      await importRequest;
      await armStage(lateImport.page, { absent: true });
      await lateImport.page.getByRole("button", { name: "그래프 해제" }).click();
      await stageSignal(lateImport.page);
      releaseImport.resolve();
      await lateImport.page.evaluate((url) => import(url).then(() => window.__task27Runtime.idle()), importedUrl);
      assert.equal(await lateImport.page.locator(".knowledge-graph-stage").count(), 0);
      assert.deepEqual(await lateImport.page.evaluate(() => window.__task27Runtime.snapshot()), { pendingRaf: 0, observers: 0, contextsCreated: 0, contextsLost: 0 });
      assert.deepEqual(lateImport.errors, []);
      result.cases.push({ name: "late-dynamic-import", unmountedBeforeResolution: true, contextsCreated: 0, callbacksAfterUnmount: 0 });
    } finally {
      releaseImport.resolve();
      await lateImport.context.close();
    }

    const blocked = result.requests.filter((request) => request.blocked);
    assert.ok(blocked.every((request) => new URL(request.url).hostname === "cdn.jsdelivr.net"), JSON.stringify(blocked));
    assert.equal(result.requests.filter((request) => request.url.includes("untrusted.invalid")).length, 0, "untrusted graph labels and image fields never trigger URL fetches");
    result.blockedExternalFontRequests = blocked.length;
    assert.equal(networkAudit.blocked.length, 0);
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await browser?.close();
    result.cleanup.browserConnection = true;
    await browserServer?.close();
    result.cleanup.chrome = browserServer ? browserServer.process().exitCode !== null || browserServer.process().signalCode !== null : true;
    await vite?.close();
    result.cleanup.vite = true;
    result.cleanup.liveServiceRequests = 0;
    await writeFile(path.join(evidence, "scenario.json"), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, "package-versions-and-hashes.json"), JSON.stringify(result.provenance, null, 2));
    await writeFile(path.join(evidence, "cleanup.json"), JSON.stringify(result.cleanup, null, 2));
    if (result.status === "passed") await copyFile(path.join(screenshotDir, "thousand-nodes.png"), path.join(evidence, "screen.png"));
  }
}

async function armStage(page, expected) {
  await page.evaluate((expected) => {
    const previousCanvas = document.querySelector(".knowledge-graph-stage__webgl canvas");
    window.__task27Signal = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`stage signal timeout: ${JSON.stringify(expected)}`)); }, 15000);
      const check = () => {
        const stage = document.querySelector(".knowledge-graph-stage");
        const matches = expected.absent ? !stage : stage && (!expected.state || stage.dataset.engineState === expected.state) && (!expected.render || stage.dataset.renderState === expected.render) && (!expected.scope || stage.dataset.scopeKey === expected.scope) && (!expected.nextCanvas || stage.querySelector("canvas") !== previousCanvas);
        if (matches) { clearTimeout(timeout); observer.disconnect(); resolve(true); }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      check();
    });
  }, expected);
}
async function waitStage(page, state, render) { await armStage(page, { state, ...(render ? { render } : {}) }); await stageSignal(page); }
async function stageSignal(page) { await page.evaluate(() => window.__task27Signal); }
async function armSelected(page) {
  await page.evaluate(() => {
    window.__task27SelectedSignal = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("selection signal timeout")); }, 15000);
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="selected-node"]')?.textContent) { clearTimeout(timeout); observer.disconnect(); resolve(true); }
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    });
  });
}
async function selectedSignal(page) { await page.evaluate(() => window.__task27SelectedSignal); }

function runtimeInstrumentation() {
  const nativeRaf = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Set();
  const idleListeners = new Set();
  const changed = () => { if (pending.size === 0) for (const listener of idleListeners) listener(); };
  window.requestAnimationFrame = (callback) => { const id = nativeRaf((time) => { pending.delete(id); callback(time); changed(); }); pending.add(id); return id; };
  window.cancelAnimationFrame = (id) => { pending.delete(id); nativeCancel(id); changed(); };
  const NativeObserver = window.ResizeObserver;
  let observers = 0, contextsCreated = 0, contextsLost = 0;
  window.ResizeObserver = class extends NativeObserver {
    constructor(callback) { super(callback); this.live = true; observers += 1; }
    disconnect() { if (this.live) { this.live = false; observers -= 1; } super.disconnect(); }
  };
  const nativeContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, options) {
    const context = nativeContext.call(this, type, options);
    if (context && ["webgl", "webgl2", "experimental-webgl"].includes(type) && !context.__task27Tracked) {
      context.__task27Tracked = true; contextsCreated += 1;
      const nativeExtension = context.getExtension.bind(context);
      context.getExtension = (name) => {
        const extension = nativeExtension(name);
        if (name === "WEBGL_lose_context" && extension && !extension.__task27Tracked) {
          extension.__task27Tracked = true;
          const nativeLose = extension.loseContext.bind(extension);
          extension.loseContext = () => { contextsLost += 1; nativeLose(); };
        }
        return extension;
      };
    }
    return context;
  };
  window.__task27Runtime = {
    snapshot: () => ({ pendingRaf: pending.size, observers, contextsCreated, contextsLost }),
    idle: () => pending.size === 0 ? Promise.resolve() : new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timeout); idleListeners.delete(done); resolve(); };
      const timeout = setTimeout(() => { idleListeners.delete(done); reject(new Error("RAF idle deadline")); }, 15000);
      idleListeners.add(done);
    }),
  };
}
function disableWebGl() {
  const nativeContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, options) {
    return ["webgl", "webgl2", "experimental-webgl", "webgpu"].includes(type) ? null : nativeContext.call(this, type, options);
  };
}
