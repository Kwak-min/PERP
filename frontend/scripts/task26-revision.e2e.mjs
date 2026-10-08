import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
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
const uploads = path.join(process.env.DEADLINE_TEMP_ROOT, 'graph-scope-uploads');
process.env.ORBITFLOW_UPLOAD_DIR = uploads;
let server, vite, browser;
function bounded(promise) {
  const signal = AbortSignal.timeout(10000);
  return Promise.race([promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
}
try {
  server = await startTestServer();
  // startTestServer migrates the complete SQLite Wiki storage and invalidation
  // DDL. This leaf is not a PostgreSQL fixture; no partial Wiki tables/stubs.
  const { db } = await import('../../backend/src/config/db.js');
  const { KNOWLEDGE_TABLES } = await import('../../backend/src/config/knowledge-schema.js');
  result.schema = {
    migrations: db().prepare('SELECT version FROM schema_migration ORDER BY version').all().map(row => row.version),
    tables: db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%' ORDER BY name").all().map(row => row.name),
    triggers: db().prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND (name LIKE 'knowledge_%' OR name LIKE 'wiki_%') ORDER BY name").all(),
  };
  assert.ok([12, 14].every(version => result.schema.migrations.includes(version)));
  assert.deepEqual(result.schema.tables, KNOWLEDGE_TABLES.map(name => `knowledge_${name}`).sort());
  assert.ok(result.schema.triggers.some(row => row.name === 'wiki_source_invalidation'));
  const { configuredWikiModel } = await import('../../backend/src/services/knowledge-wiki-worker.service.js');
  assert.equal(configuredWikiModel(), null, 'admission only: no model or worker is started');
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
    const pageErrors = [], http = [], routeErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/api/v1/documents')) http.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    await page.addInitScript(session => {
      localStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
      localStorage.setItem('orbitflow.demoMode', '0');
      window.__revisionRequests = [];
      const original = window.fetch;
      window.fetch = async (url, options = {}) => {
        const record = { url: String(url), method: options.method ?? 'GET', org: new Headers(options.headers).get('X-Org-Id'), aborted: false, settled: false, responseReceived: false };
        const done = Promise.withResolvers();
        record.done = done.promise;
        window.__revisionRequests.push(record);
        options.signal?.addEventListener('abort', () => { record.aborted = true; record.abortName = options.signal.reason.name; }, { once: true });
        const finish = () => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); record.settled = true; done.resolve(); };
          channel.port2.postMessage(null);
        };
        try {
          const response = await original(url, options);
          record.responseReceived = true;
          const json = response.json.bind(response);
          response.json = () => json().then(body => { record.body = body; window.dispatchEvent(new Event('revision-body')); return body; }).finally(finish);
          return response;
        } catch (error) { record.errorName = error.name; finish(); throw error; }
      };
    }, session);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers(), released = Promise.withResolvers();
    let targetPath, stored, receipt, source;
    const targetMethod = operation === 'save' ? 'PATCH' : 'POST';
    const content = operation === 'save' ? '# Revision committed before abort' : operation === 'upload' ? '# Revision upload' : '# Initial';
    const question = 'Revision analysis private question';
    try {
      if (operation !== 'upload') {
        const created = await api(server.baseUrl, '/documents', { ...owner, method: 'POST', body: { title: `Revision ${operation}`, content: '# Initial' } });
        assert.equal(created.status, 201);
        stored = created.body;
      }
      targetPath = operation === 'save' ? `/api/v1/documents/${stored.id}` : operation === 'upload' ? '/api/v1/documents/upload' : '/api/v1/documents/wiki/jobs';
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
      // Cancellation is not a pixel-picking test: use the shipped Stage's
      // accessible node controls, which open the actual document detail.
      const nodes = page.getByRole('list', { name: '조직 지식 3D 그래프 노드 목록', exact: true });
      await nodes.waitFor();
      await page.locator('[data-wiki-workspace][data-loading="false"]').waitFor();
      if (stored) {
        const detail = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/documents/${stored.id}` && r.request().method() === 'GET');
        await nodes.getByRole('button').filter({ hasText: stored.title }).click();
        assert.equal((await detail).status(), 200);
        await page.getByRole('button', { name: '본문 수정', exact: true }).waitFor();
      }
      if (operation === 'save') {
        await page.getByRole('button', { name: '본문 수정', exact: true }).click();
        await page.getByRole('textbox', { name: '원본 문서 본문', exact: true }).fill(content);
      } else if (operation === 'analysis') {
        // Current analysis is explicit raw-first Wiki research, not an obsolete
        // upload-triggered GET /documents/:id/analysis. Admission is a real
        // durable POST mutation; hold its unchanged 202 without running a model.
        const registered = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/documents/wiki/sources' && r.request().method() === 'POST');
        await page.getByRole('button', { name: '선택 원본 등록', exact: true }).click();
        const response = await registered;
        assert.equal(response.status(), 201);
        source = await response.json();
        await page.getByRole('checkbox', { name: `조사 원본 ${stored.title}`, exact: true }).check();
        await page.getByRole('textbox', { name: '위키 조사 질문', exact: true }).fill(question);
      }
      await page.route(`**${targetPath}`, async route => {
        if (route.request().method() !== targetMethod) return route.continue();
        try {
          const response = await route.fetch();
          assert.equal(response.status(), operation === 'save' ? 200 : operation === 'upload' ? 201 : 202);
          receipt = await response.json();
          if (operation === 'upload') stored = receipt;
          if (operation === 'analysis') {
            const request = route.request().postDataJSON();
            assert.deepEqual(request, { operation: 'query', question, retrieval: { raw: true, published_wiki: true, source_revision_ids: [source.current_revision_id] } });
            assert.ok(route.request().headers()['idempotency-key']);
            assert.equal(receipt.operation, 'query');
            assert.equal(receipt.state, 'queued');
          }
          entered.resolve();
          await gate.promise;
          await route.fulfill({ response });
        } catch (error) {
          routeErrors.push(String(error)); entered.resolve();
          await route.abort();
        } finally { released.resolve(); }
      });
      if (operation === 'save') await page.getByRole('button', { name: '변경 저장', exact: true }).click();
      else if (operation === 'upload') await page.getByLabel('조직 문서 파일 올리기', { exact: true }).setInputFiles({ name: 'revision-upload.md', mimeType: 'text/markdown', buffer: Buffer.from(content) });
      else await page.getByRole('button', { name: '원본 기반 조사', exact: true }).click();
      await bounded(entered.promise);
      assert.deepEqual(routeErrors, []);
      const target = { targetPath, targetMethod, org: owner.orgId };
      const pending = await page.evaluate(({ targetPath, targetMethod, org }) => {
        const matches = window.__revisionRequests.map((request, index) => ({ request, index })).filter(({ request: r }) => new URL(r.url, location.origin).pathname === targetPath && r.org === org && r.method === targetMethod);
        if (matches.length !== 1) throw new Error(`Expected exactly one mutation, observed ${matches.length}`);
        const { request, index } = matches[0];
        return { index, aborted: request.aborted, settled: request.settled, responseReceived: request.responseReceived };
      }, target);
      assert.deepEqual(pending, { index: pending.index, aborted: false, settled: false, responseReceived: false }, 'real mutation is pending behind the hold BEFORE scope change');
      const persistedPath = operation === 'analysis' ? `/documents/wiki/jobs/${receipt.id}` : `/documents/${stored.id}`;
      const committed = await api(server.baseUrl, persistedPath, owner);
      assert.equal(committed.status, 200);
      if (operation === 'analysis') assert.deepEqual(committed.body, receipt);
      else { assert.equal(committed.body.content, content); assert.equal(committed.body.version, receipt.version); }
      const currentGraph = graphBody(other.orgId);
      await page.locator('.workspace-picker__button').click();
      const before = await page.evaluate(() => window.__revisionRequests.length);
      await page.getByRole('menuitemradio', { name: /Revision B/ }).click();
      const graph = await currentGraph;
      assert.equal(graph.nodes.length, 0);
      // done is subscribed at fetch entry. Its MessageChannel runs after the
      // rejection continuations, not after an arbitrary sleep/render delay.
      const record = await bounded(page.evaluate(async index => {
        const request = window.__revisionRequests[index];
        await request.done;
        return { aborted: request.aborted, abortName: request.abortName, errorName: request.errorName, settled: request.settled, responseReceived: request.responseReceived, url: request.url, method: request.method };
      }, pending.index));
      assert.equal(record.aborted, true, 'scope change must cancel the pending mutation/analysis request');
      assert.equal(record.abortName, 'AbortError', 'a request timeout cannot satisfy the cancellation regression');
      assert.equal(record.errorName, 'AbortError');
      assert.equal(record.responseReceived, false, 'abort observed before releasing the unchanged real response');
      gate.resolve(); await bounded(released.promise);
      const fresh = await api(server.baseUrl, persistedPath, owner);
      assert.equal(fresh.status, 200, 'abort does not roll back an already committed write');
      assert.deepEqual(fresh.body, committed.body, 'exact committed content/version or queued job survives abort and release');
      if (operation === 'upload') {
        const file = db().prepare('SELECT storage_key FROM file_object WHERE id=? AND related_id=?').get(receipt.file_id, stored.id);
        assert.ok(file);
        assert.equal(await readFile(path.join(uploads, file.storage_key), 'utf8'), content, 'already committed upload bytes survive cancellation too');
      }
      assert.equal((await api(server.baseUrl, persistedPath, other)).status, 404, 'committed write stays private to its original scope');
      await page.locator('[data-wiki-workspace][data-loading="false"]').waitFor();
      assert.equal(await nodes.getByRole('button').count(), 0);
      assert.equal(await page.getByRole('button', { name: '본문 수정', exact: true }).count(), 0);
      assert.equal(await page.getByRole('textbox', { name: '원본 문서 본문', exact: true }).count(), 0);
      assert.equal(await page.getByRole('textbox', { name: '위키 조사 질문', exact: true }).inputValue(), '');
      assert.equal(await page.locator('[data-job-id], .wiki-sources li, .wiki-revision').count(), 0);
      const visible = await page.locator('main').innerText();
      for (const stale of [stored.title ?? stored.filename, content.slice(2), question, receipt.id]) assert.ok(!visible.includes(stale), `old-scope content leaked: ${stale}`);
      await page.screenshot({ path: `${evidence}/${operation}.png`, fullPage: true });
      const followups = await page.evaluate(({ before, org }) => window.__revisionRequests.slice(before).filter(r => r.org === org && r.url.includes('/documents')).map(({ url, method }) => ({ url, method })), { before, org: owner.orgId });
      assert.deepEqual(followups, [], 'old-company completion must not launch graph, detail, Wiki refresh or analysis');
      assert.deepEqual(routeErrors, []);
      const reloadStart = await page.evaluate(() => window.__revisionRequests.length);
      const returnedGraph = graphBody(owner.orgId, reloadStart);
      await page.locator('.workspace-picker__button').click();
      const originalCompany = session.organizations.find(org => org.org_id === owner.orgId);
      await page.getByRole('menuitemradio', { name: new RegExp(originalCompany.org_name) }).click();
      assert.ok((await returnedGraph).nodes.some(node => node.id === stored.id), 'returning to the target scope reloads the committed write');
      if (operation === 'analysis') {
        await page.getByText('저장한 작업·초안 다시 열기', { exact: true }).click();
        await page.getByLabel('저장한 작업 ID', { exact: true }).fill(receipt.id);
        const reopened = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${persistedPath}` && r.request().method() === 'GET');
        await page.getByRole('button', { name: '인가된 작업 다시 열기', exact: true }).click();
        assert.deepEqual(await (await reopened).json(), committed.body);
        await page.locator(`[data-job-id="${receipt.id}"][data-job-state="queued"]`).waitFor();
        assert.deepEqual(fresh.body.attempts, [], 'no model execution or implicit retry');
        assert.equal(fresh.body.result, null);
      } else {
        const reopened = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${persistedPath}` && r.request().method() === 'GET');
        await nodes.getByRole('button').filter({ hasText: stored.title ?? stored.filename }).click();
        assert.equal((await reopened).status(), 200);
        await page.getByRole('button', { name: '본문 수정', exact: true }).waitFor();
        assert.ok((await page.locator('main').innerText()).includes(content.slice(2)), 'fresh real detail renders the persisted content');
      }
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(http.filter(response => response.status >= 400), [], 'integrated Wiki/graph requests cannot hide missing schema or other HTTP failures');
      result.cases.push({ operation, targetPath, pending, record, followups, storedId: stored.id, receipt, committed: committed.body, persisted: fresh.body, currentCompany: other.orgId, safeCurrentReload: true, http, pageErrors });
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
  await rm(uploads, { recursive: true, force: true }); result.cleanup.uploadsRemoved = !existsSync(uploads);
  await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2));
}
assert.deepEqual(result.errors, []);
console.log(JSON.stringify(result, null, 2));
