import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { setupJobs } from '../../backend/tests/deadline-wiki-jobs-fixture.js';
import { task28LocalProvider } from './task28-local-provider.mjs';
import { admitWikiJob, runWikiJob } from '../../backend/src/services/knowledge-wiki-jobs.service.js';
import { inspectChangeSet, publishChangeSet } from '../../backend/src/services/knowledge-wiki-publication.service.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const evidence = path.join(root, 'frontend/.artifacts/graph-ui-st01a086a4', baseline ? 'before' : 'after');
await mkdir(evidence, { recursive: true });
const report = { baseline, checks: [], findings: [], screens: [], errors: [] };
let f, provider, vite, browser;
// Exact DOM change subscription, installed before actions. Timeout only bounds failure.
async function arm(page, selector) {
  await page.evaluate(selector => {
    window.graphSignal = new Promise((resolve, reject) => {
      const check = () => { if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(true); } };
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('DOM signal: ' + selector)); }, 15000);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); check();
    });
  }, selector);
}
async function done(page) { await page.evaluate(() => window.graphSignal); }
async function change(page, selector, action) { await arm(page, selector); await action(); await done(page); }
async function check(name, fn) { try { await fn(); report.checks.push(name); } catch (error) { report.findings.push({ name, message: error.message }); } }
try {
  f = await setupJobs('legacy'); provider = await task28LocalProvider();
  process.env.WIKI_LOCAL_MODEL_CONFIG = JSON.stringify(provider.config);
  const space = await f.api.request(f.a, '/documents/spaces', 'POST', { name: '운영 지침' }, 201);
  const docA = await f.api.request(f.a, '/documents', 'POST', { title: '신규 구성원 안내', content: '# 신규 구성원 안내\n\n운영 지침을 먼저 확인하세요. [[회의 운영 원칙]]', visibility: 'org', space_id: space.id }, 201);
  await f.api.request(f.a, '/documents', 'POST', { title: '회의 운영 원칙', content: '# 회의 운영 원칙\n\n결정과 근거를 함께 기록합니다. [[신규 구성원 안내]]', visibility: 'org', space_id: space.id }, 201);
  await f.api.request(f.a, '/documents', 'POST', { title: '긴 제목의 프로젝트 인수인계와 담당자별 확인 사항을 정리한 문서', content: '# 인수인계\n\n후임 담당자와 확인합니다.', visibility: 'org' }, 201);
  const source = await f.api.request(f.a, f.root + '/sources', 'POST', { kind: 'record', origin_kind: 'document', origin_id: docA.id, version: docA.version }, 201);
  const admitted = await admitWikiJob(f.context, { operation: 'ingest', source_revision_ids: [source.current_revision_id] }, randomUUID(), provider.config);
  const result = await runWikiJob(f.context, admitted.job.id);
  const review = await inspectChangeSet(f.context, result.change_set_id);
  await publishChangeSet(f.context, review.id, { manifest_hash: review.manifest_hash, confirmed: true }, randomUUID());
  vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), cacheDir: path.join(process.env.DEADLINE_TEMP_ROOT, 'vite-graph-ui'), envDir: process.env.DEADLINE_TEMP_ROOT, resolve: { alias: { 'graph-ui-actual-engine': path.join(root, 'node_modules/3d-force-graph/dist/3d-force-graph.mjs').replaceAll('\\', '/') } }, optimizeDeps: { exclude: ['3d-force-graph'], include: ['graph-ui-actual-engine', 'react', 'react-dom/client', 'zod'] }, plugins: [{ name: 'graph-ui-observer', enforce: 'pre', resolveId(id) { if (id === '3d-force-graph') return '\0graph-ui-engine'; }, load(id) { if (id === '\0graph-ui-engine') return `import Actual from 'graph-ui-actual-engine'; export default function(...args) { const graph = new Actual(...args); (window.graphUiEngines ??= []).push(graph); const setStop = graph.onEngineStop; graph.onEngineStop = function(callback) { if (!arguments.length) return setStop.call(graph); return setStop.call(graph, function(...args) { callback(...args); queueMicrotask(() => window.dispatchEvent(new CustomEvent('graph-ui-stop', { detail: window.graphUiEngines.indexOf(graph) }))); }); }; return graph; }`; } }, react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: new URL(f.api.baseUrl).origin } }, watch: { ignored: ['**/.artifacts/**', '**/.omo/**'] } } });
  await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking', '--disable-sync'] });
  report.chrome = browser.version();
  const me = await f.api.request(f.a, '/auth/me');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(session => sessionStorage.setItem('orbitflow.session.v1', JSON.stringify(session)), { token: f.a.token, orgId: f.a.orgId, name: '합성 검토 사용자', email: 'visual@example.invalid', mustChangePassword: false, organizations: me.organizations });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/documents/graph', { waitUntil: 'domcontentloaded' });
  await arm(page, '[data-wiki-workspace][data-loading="false"] [data-engine-state="ready"]'); await done(page);
  await arm(page, '.graph-layout [data-engine-state="ready"]'); await done(page);
  async function capture(name) {
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve, reject) => {
          const check = () => { if ([...document.querySelectorAll('.knowledge-graph-stage canvas')].every(c => {
            const host = c.closest('.knowledge-graph-stage__webgl'), graph = window.graphUiEngines.find(g => g.renderer().domElement === c);
            return c.width === Math.round(host.clientWidth * devicePixelRatio) && c.height === Math.round(host.clientHeight * devicePixelRatio)
              && graph.camera().aspect === host.clientWidth / host.clientHeight && host.dataset.paintedSize === `${host.clientWidth}:${host.clientHeight}`;
          })) { clearTimeout(timer); observer.disconnect(); resolve(); } };
          const observer = new MutationObserver(check), timer = setTimeout(() => { observer.disconnect(); reject(new Error('canvas resize')); }, 15000);
          observer.observe(document.documentElement, { subtree: true, attributes: true }); check();
        });
        window.scrollTo(0, 0);
      });
      await check(`${name} actual projection and labels ${width}`, async () => {
        const frames = await page.evaluate(() => [...document.querySelectorAll('.knowledge-graph-stage canvas')].map(canvas => {
          const g = window.graphUiEngines.find(g => g.renderer().domElement === canvas), host = canvas.closest('.knowledge-graph-stage__webgl');
          return { width: g.width(), height: g.height(), nodes: g.graphData().nodes.map(n => g.graph2ScreenCoords(n.x,n.y,n.z)), labels: [...host.querySelectorAll('.knowledge-graph-stage__label:not([hidden])')].map(el=>el.textContent) };
        }));
        for (const frame of frames) { assert.ok(frame.labels.length >= 2, JSON.stringify(frame)); for (const node of frame.nodes) assert.ok(node.x >= 0 && node.x <= frame.width && node.y >= 0 && node.y <= frame.height, JSON.stringify(frame)); }
      });
      const file = `${name}-${width}.png`; await page.screenshot({ path: path.join(evidence, file), fullPage: true, animations: 'disabled' }); report.screens.push(file);
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      await check(name + ' overflow ' + width, () => assert.ok(size.scroll <= size.width + 1, JSON.stringify(size)));
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  report.engines = await page.evaluate(() => window.graphUiEngines.map(g => ({ camera: g.cameraPosition(), box: g.getGraphBbox(), nodes: g.graphData().nodes.map(n => ({ id: n.id, x: n.x, y: n.y, z: n.z })), width: g.width(), height: g.height() })));
  await check('settled meshes occupy their simulated positions before first paint', async () => {
    const positions = await page.evaluate(() => window.graphUiEngines.flatMap(g => g.graphData().nodes.map(n => ({ x: n.x, meshX: n.__threeObj.position.x, y: n.y, meshY: n.__threeObj.position.y }))));
    for (const node of positions) { assert.equal(node.meshX, node.x); assert.equal(node.meshY, node.y); }
  });
  await check('both real graphs render readable node labels at settled coordinates', async () => {
    for (const selector of ['.graph-layout .knowledge-graph-stage', '[data-wiki-workspace] .knowledge-graph-stage']) {
      const graph = page.locator(selector);
      assert.equal(await graph.getAttribute('data-engine-state'), 'ready');
      const labels = await graph.locator('.knowledge-graph-stage__label:not([hidden])').allTextContents();
      assert.ok(labels.length >= 2, JSON.stringify(labels)); assert.ok(labels.every(label => label.trim().length > 0));
    }
  });
  await capture('overview');
  const stage = page.locator('.graph-layout .knowledge-graph-stage');
  await change(page, '.graph-layout .md-body', () => stage.locator('.knowledge-graph-stage__nodes button').filter({ hasText: '신규 구성원 안내' }).click());
  async function filterCycle(checked) {
    if (!baseline) await page.evaluate(() => {
      window.graphCycle = new Promise((resolve, reject) => {
        const listener = event => { const graph = window.graphUiEngines[event.detail]; if (graph.renderer().domElement === document.querySelector('.graph-layout canvas')) { clearTimeout(timer); window.removeEventListener('graph-ui-stop', listener); resolve(); } };
        const timer = setTimeout(() => { window.removeEventListener('graph-ui-stop', listener); reject(new Error('filter render cycle')); }, 15000);
        window.addEventListener('graph-ui-stop', listener);
      });
    });
    await stage.getByRole('checkbox', { name: '직접 위키 링크' }).setChecked(checked);
    if (!baseline) await page.evaluate(() => window.graphCycle);
  }
  await page.evaluate(() => { window.beforeFilterCanvas = document.querySelector('.graph-layout canvas'); });
  await filterCycle(false);
  await check('relation filtering preserves the active renderer and selected node', async () => {
    assert.equal(await page.evaluate(() => window.beforeFilterCanvas === document.querySelector('.graph-layout canvas')), true);
    assert.equal(await stage.locator('.knowledge-graph-stage__nodes button[aria-pressed="true"]').count(), 1);
  });
  await filterCycle(true);
  await check('filtered renderer retains painted mesh positions', async () => {
    const positions = await page.evaluate(() => window.graphUiEngines.find(g => g.renderer().domElement === document.querySelector('.graph-layout canvas')).graphData().nodes.map(n => [n.x, n.__threeObj.position.x]));
    for (const [x, meshX] of positions) assert.equal(meshX, x);
  });
  await check('search narrows semantic nodes without changing graph identity', async () => {
    const search = stage.locator('input[type="search"]'); assert.equal(await search.count(), 1);
    await search.fill('회의'); assert.equal(await stage.locator('.knowledge-graph-stage__nodes button').count(), 1);
    await search.fill('존재하지않음'); assert.equal(await stage.locator('.knowledge-graph-stage__nodes button').count(), 0);
    await search.fill(''); assert.equal(await stage.locator('.knowledge-graph-stage__nodes button').count(), 4);
  });
  await check('wiki relationship predicates have semantic labels outside raw JSON', async () => {
    await page.locator('[data-wiki-workspace] .knowledge-graph-stage__semantics > details > summary').click();
    assert.ok(await page.locator('[data-wiki-workspace] [data-predicate="supports"]').count() > 0);
    assert.ok(await page.locator('[data-wiki-workspace] [data-predicate="contradicts"]').count() > 0);
  });
  await check('published workspace disclosure opens the original registration and query controls', async () => {
    const panel = page.locator('.wiki-research');
    assert.equal(await panel.getAttribute('open'), null);
    await panel.locator(':scope > summary').click();
    assert.equal(await panel.getByLabel('위키 조사 질문').isVisible(), true);
    assert.equal(await panel.getByLabel('위키 원본 파일 올리기', { exact: true }).isVisible(), true);
    await panel.locator(':scope > summary').click();
    assert.equal(await panel.getAttribute('open'), null);
  });
  await capture('selected');
  const pageOpen = page.locator('[data-page-id]').first();
  const pageRevision = await pageOpen.getAttribute('data-page-revision-id');
  await change(page, `.wiki-revision[data-revision-id="${pageRevision}"]`, () => pageOpen.click());
  await capture('wiki-detail');
  await change(page, '.wiki-revision mark', () => page.locator('.wiki-revision .wiki-citations button').first().click());
  assert.ok((await page.locator('.wiki-revision mark').textContent()).includes('운영 지침'));
  await capture('citation');
  // Source and publication remain actual server records, not browser response stubs.
  assert.equal((await f.api.request(f.a, `/documents/${docA.id}`)).version, docA.version);
  assert.equal((await f.api.request(f.a, f.root + '/pages')).items.length, 3);
  report.checks.push('immutable source unchanged; published pages persist; exact citation opens');
  await context.close();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.findings, []);
  console.log('GRAPH_UI_REVIEW_PASS');
} catch (error) { report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await browser?.close(); await vite?.close(); await provider?.close(); if (f) await f.close({ graphUi: true });
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, checks: report.checks, findings: report.findings, error: report.error }, null, 2));
}
