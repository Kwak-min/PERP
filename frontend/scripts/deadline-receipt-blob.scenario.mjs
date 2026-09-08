import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import sharp from 'sharp';
import { startDeadlineServer } from '../../backend/tests/deadline-fixture.js';
import { createOwnerOrg } from '../../backend/tests/http.js';
import { protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/task-16-deadline-erp-redesign');
const result = { status: 'running', surface: 'actual apiBlob module in Chrome; no expense UI claimed', resources: [] };
await writeFile(path.join(evidence, 'browser-scenario.json'), JSON.stringify(result));
await rm(path.join(evidence, 'browser-cleanup.json'), { force: true });
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'browser-receipts');
let api, vite, browserServer, browser;
try {
  api = await startDeadlineServer(); result.resources.push(api.resource);
  const actor = await createOwnerOrg(api.baseUrl, ['finance']);
  const parent = await api.request(actor, '/finance/transactions', 'POST', { kind: 'expense', amount_minor: 100, occurred_on: '2026-09-08' }, 201);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } }).png().toBuffer();
  const response = await fetch(api.baseUrl + '/finance/transactions/receipt-uploads', { method: 'POST', headers: {
    Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'image/png', 'X-Upload-Name': encodeURIComponent('브라우저 영수증.png') }, body: png, signal: AbortSignal.timeout(10000) });
  const uploaded = await response.json(); assert.equal(response.status, 201, JSON.stringify(uploaded));
  const { resolvePrincipal } = await import('../../backend/src/middleware/auth.js');
  const { transaction } = await import('../../backend/src/config/db.js');
  const { consumeLegacyReceipts } = await import('../../backend/src/services/legacy-receipt-files.service.js');
  const principal = resolvePrincipal({ get: name => ({ authorization: `Bearer ${actor.token}`, 'x-org-id': actor.orgId })[name] });
  const [file] = transaction(() => consumeLegacyReceipts(principal, { kind: 'transaction', parentId: parent.id, expectedVersion: parent.version, tokens: [uploaded.token] }))();
  vite = await createServer({ configFile: false, root: path.join(root, 'frontend'), envDir: process.env.DEADLINE_TEMP_ROOT,
    plugins: [{ name: 'receipt-module-qa', configureServer(server) {
      server.middlewares.use('/receipt-module-qa', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Receipt module QA</title><body>Authenticated receipt module fixture</body></html>'); });
    } }], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**'] } } });
  await vite.listen();
  const port = vite.httpServer.address().port; assert.ok(!protectedPorts.has(port));
  const origin = `http://127.0.0.1:${port}`;
  result.resources.push({ kind: 'vite', pid: process.pid, port, closed: false });
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, timeout: 20000,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const processHandle = browserServer.process(), profile = processHandle.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  result.resources.push({ kind: 'chrome', pid: processHandle.pid, profile, closed: false });
  browser = await chromium.connect(browserServer.wsEndpoint()); result.chrome = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage();
  await page.goto(origin + '/receipt-module-qa', { waitUntil: 'domcontentloaded' });
  result.result = await page.evaluate(async ({ session, parentId, fileId }) => {
    const { apiBlob, ApiError } = await import('/src/services/api.ts');
    const target = `/finance/transactions/${parentId}/receipts/${fileId}`;
    const received = await apiBlob(target, { session });
    const objectUrl = URL.createObjectURL(received.blob);
    let digest;
    try {
      const bytes = await (await fetch(objectUrl)).arrayBuffer();
      digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
    } finally { URL.revokeObjectURL(objectUrl); }
    let revoked = false;
    try { await fetch(objectUrl); } catch (error) { if (!(error instanceof TypeError)) throw error; revoked = true; }
    const errors = [];
    for (const [route, credentials] of [[target, { ...session, token: 'invalid' }], ['https://example.invalid/a.png', session]]) {
      try { await apiBlob(route, { session: credentials }); throw new Error('Expected rejection'); }
      catch (error) { if (!(error instanceof ApiError)) throw error; errors.push({ code: error.code, status: error.status }); }
    }
    const controller = new AbortController(); controller.abort();
    let aborted = false;
    try { await apiBlob(target, { session, signal: controller.signal }); }
    catch (error) { if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error; aborted = true; }
    return { digest, filename: received.filename, type: received.blob.type, revoked, errors, aborted };
  }, { session: { token: actor.token, orgId: actor.orgId }, parentId: parent.id, fileId: file.file_id });
  assert.equal(result.result.digest, createHash('sha256').update(png).digest('hex'));
  assert.equal(result.result.filename, '브라우저 영수증.png'); assert.equal(result.result.type, 'image/png'); assert.equal(result.result.revoked, true);
  assert.equal(result.result.aborted, true); assert.deepEqual(result.result.errors.map(error => error.status), [401, 400]);
  result.status = 'passed'; console.log(JSON.stringify(result.result, null, 2));
} catch (error) { result.status = 'failed'; result.error = error.message; throw error; }
finally {
  await browser?.close(); await browserServer?.close(); await vite?.close(); await api?.close();
  for (const resource of result.resources) {
    resource.closed = true;
    if (resource.profile) resource.profileRemoved = !existsSync(resource.profile);
  }
  await writeFile(path.join(evidence, 'browser-scenario.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(evidence, 'browser-cleanup.json'), JSON.stringify(result.resources, null, 2));
}
