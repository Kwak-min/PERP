import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = `${root}.omo/evidence/task-26-revision/${process.argv[2] ?? 'browser'}`;
await mkdir(evidence, { recursive: true });
const result = { cases: [], errors: [], cleanup: {} };
let server, vite, browser;
function bounded(promise) {
  const signal = AbortSignal.timeout(10000);
  return Promise.race([promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
}
try {
  server = await startTestServer();
  const owner = await createOwnerOrg(server.baseUrl, ['documents', 'agent']);
  const second = await api(server.baseUrl, '/tenants', { ...owner, method: 'POST', body: { name: 'Revision B', type: 'custom', modules: ['documents', 'agent'], features: [], departments: [] } });
  assert.equal(second.status, 201);
  const other = { ...owner, orgId: second.body.org_id };
  const me = await api(server.baseUrl, '/auth/me', owner);
  const session = { ...owner, name: me.body.name, email: me.body.email, organizations: me.body.organizations, mustChangePassword: false };
  vite = await createServer({ configFile: false, root: `${root}frontend`, envDir: process.env.DEADLINE_TEMP_ROOT, plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  result.chrome = browser.version();
  for (const operation of ['save', 'upload', 'analysis']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.addInitScript(session => {
      localStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
      localStorage.setItem('orbitflow.demoMode', '0');
      window.__revisionRequests = [];
      const original = window.fetch;
      window.fetch = async (url, options = {}) => {
        const record = { url: String(url), method: options.method ?? 'GET', org: new Headers(options.headers).get('X-Org-Id'), aborted: false };
        const done = Promise.withResolvers();
        record.done = done.promise;
        window.__revisionRequests.push(record);
        options.signal?.addEventListener('abort', () => { record.aborted = true; record.abortName = options.signal.reason.name; }, { once: true });
        const finish = () => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); done.resolve(); };
          channel.port2.postMessage(null);
        };
        try {
          const response = await original(url, options);
          const json = response.json.bind(response);
          response.json = () => json().then(body => { record.body = body; window.dispatchEvent(new Event('revision-body')); return body; }).finally(finish);
          return response;
        } catch (error) { finish(); throw error; }
      };
    }, session);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers(), released = Promise.withResolvers();
    let targetPath, stored;
    try {
      if (operation === 'save') {
        const created = await api(server.baseUrl, '/documents', { ...owner, method: 'POST', body: { title: 'Revision Save', content: '# Initial' } });
        assert.equal(created.status, 201);
        stored = created.body;
        targetPath = `/api/v1/documents/${stored.id}`;
      } else targetPath = operation === 'upload' ? '/api/v1/documents/upload' : null;
      async function graphBody(org, after = 0) {
        return page.evaluate(({ org, after }) => new Promise((resolve, reject) => {
          const timeout = AbortSignal.timeout(10000);
          const check = () => {
            const request = window.__revisionRequests.slice(after).findLast(r => r.org === org && r.url.endsWith('/documents/graph') && r.body?.nodes);
            if (request) { window.removeEventListener('revision-body', check); resolve(request.body); }
          };
          window.addEventListener('revision-body', check, { signal: timeout });
          timeout.addEventListener('abort', () => reject(timeout.reason), { once: true });
          check();
        }), { org, after });
      }
      await page.goto(`${origin}/documents/graph`, { waitUntil: 'domcontentloaded' });
      await graphBody(owner.orgId);
      const canvas = page.getByRole('application', { name: '조직 지식 3D 그래프' });
      await canvas.waitFor();
      if (operation === 'save') {
        const detail = page.waitForResponse(r => new URL(r.url()).pathname === targetPath && r.request().method() === 'GET').then(r => r.json());
        const box = await canvas.boundingBox();
        await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
        await detail;
        await page.getByRole('button', { name: '본문 수정', exact: true }).click();
        await page.getByLabel('본문 (마크다운)').fill('# Revision committed before abort');
      }
      await page.route('**/api/v1/documents/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (pathname === '/api/v1/documents/upload' && request.method() === 'POST') {
          const response = await route.fetch();
          assert.equal(response.status(), 201);
          stored = await response.json();
          const body = { ...stored, analysis: { state: 'pending', version: 1, model: null, local_only: true } };
          if (operation === 'upload') { entered.resolve(); await gate.promise; await route.fulfill({ response, json: body }); released.resolve(); }
          else { targetPath = `/api/v1/documents/${stored.id}/analysis`; await route.fulfill({ response, json: body }); }
        } else if ((operation === 'save' && pathname === targetPath && request.method() === 'PATCH') || (operation === 'analysis' && pathname === targetPath)) {
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          entered.resolve(); await gate.promise; await route.fulfill({ response }); released.resolve();
        } else await route.continue();
      });
      if (operation === 'save') await page.getByRole('button', { name: '변경 저장', exact: true }).click();
      else await page.getByLabel('조직 문서 파일 올리기').setInputFiles({ name: `revision-${operation}.md`, mimeType: 'text/markdown', buffer: Buffer.from('# Revision upload') });
      await bounded(entered.promise);
      const currentGraph = graphBody(other.orgId);
      await page.locator('.workspace-picker__button').click();
      await page.getByRole('menuitemradio', { name: /Revision B/ }).click();
      const graph = await currentGraph;
      assert.equal(graph.nodes.length, 0);
      const before = await page.evaluate(() => window.__revisionRequests.length);
      gate.resolve(); await bounded(released.promise);
      const record = await page.evaluate(async ({ targetPath, org }) => {
        const request = window.__revisionRequests.find(r => new URL(r.url, location.origin).pathname === targetPath && r.org === org && (r.method === 'PATCH' || r.method === 'POST' || r.url.includes('/analysis')));
        if (!request) throw new Error('mutation request not observed');
        await request.done;
        return { aborted: request.aborted, abortName: request.abortName, url: request.url, method: request.method };
      }, { targetPath, org: owner.orgId });
      const followups = await page.evaluate(({ before, org }) => window.__revisionRequests.slice(before).filter(r => r.org === org && r.url.includes('/documents')).map(({ url, method }) => ({ url, method })), { before, org: owner.orgId });
      const fresh = await api(server.baseUrl, `/documents/${stored.id}`, owner);
      assert.equal(fresh.status, 200, 'abort does not roll back an already committed write');
      assert.deepEqual(followups, [], 'old-company completion must not launch graph, detail or analysis');
      assert.equal(record.aborted, true, 'scope change must cancel the pending mutation/analysis request');
      assert.equal(record.abortName, 'AbortError', 'a request timeout cannot satisfy the cancellation regression');
      assert.equal(await page.getByRole('button', { name: '본문 수정', exact: true }).count(), 0);
      await page.screenshot({ path: `${evidence}/${operation}.png`, fullPage: true });
      const reloadStart = await page.evaluate(() => window.__revisionRequests.length);
      const returnedGraph = graphBody(owner.orgId, reloadStart);
      await page.locator('.workspace-picker__button').click();
      const originalCompany = session.organizations.find(org => org.org_id === owner.orgId);
      await page.getByRole('menuitemradio', { name: new RegExp(originalCompany.org_name) }).click();
      assert.ok((await returnedGraph).nodes.some(node => node.id === stored.id), 'returning to the target scope reloads the committed write');
      result.cases.push({ operation, record, followups, storedId: stored.id, persisted: fresh.body.content, currentCompany: other.orgId, safeCurrentReload: true });
    } catch (error) {
      result.errors.push({ operation, error: String(error), stack: error.stack });
    } finally {
      gate.resolve();
      await page.unrouteAll({ behavior: 'wait' });
      await context.close();
      if (stored?.id) assert.equal((await api(server.baseUrl, `/documents/${stored.id}`, { ...owner, method: 'DELETE' })).status, 200);
    }
  }
} finally {
  await browser?.close(); result.cleanup.browser = true;
  await vite?.close(); result.cleanup.vite = true;
  await server?.close(); result.cleanup.api = true;
  await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2));
}
assert.deepEqual(result.errors, []);
console.log(JSON.stringify(result, null, 2));
