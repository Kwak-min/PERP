import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { initializeDeadlineSession } from './deadline-browser-session.mjs';
import { protectedPorts, networkAudit } from '../../scripts/deadline-isolation-guard.mjs';

const session = { token: 'isolated-session-regression', orgId: 'fixture-only' };

test('session initializer skips originless/foreign storage but propagates authorized storage errors', async () => {
  let initializer, argument, listener;
  await initializeDeadlineSession({
    on(event, callback) { assert.equal(event, 'weberror'); listener = callback; },
    async addInitScript(callback, value) { assert.ok(listener); initializer = callback; argument = value; },
  }, { origin: 'http://127.0.0.1:12345', session, demoMode: true, onPageError() {} });
  const denied = new Error('AUTHORIZED_STORAGE_DENIED');
  for (const origin of ['null', 'https://foreign.invalid', argument.origin]) {
    let accessed = false;
    const sandbox = { argument, location: { origin }, denied, markAccess() { accessed = true; } };
    // Define the throwing accessor in the VM realm; contextifying a host getter
    // replaces its thrown error with ReferenceError during global-name lookup.
    const invoke = () => runInNewContext(`
      Object.defineProperty(globalThis, 'localStorage', { get() { markAccess(); throw denied; } });
      (${initializer.toString()})(argument)
    `, sandbox);
    if (origin === argument.origin) { assert.throws(invoke, error => error === denied); assert.equal(accessed, true); }
    else { invoke(); assert.equal(accessed, false); }
  }
});

test('real Chrome originless pages stay clean, session is origin-scoped, and creation/runtime errors are captured', { timeout: 60000 }, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1', 'run through scripts/run_deadline_isolated.mjs');
  const servers = [], contexts = [], resources = [];
  let browserServer, browser;
  async function httpOrigin() {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(request.url === '/error'
        ? '<!doctype html><script>throw new Error("DEADLINE_AUTHORIZED_PAGE_ERROR")</script>'
        : '<!doctype html><script>window.sessionAtStartup = localStorage.getItem("orbitflow.session.v1")</script>');
    });
    servers.push(server);
    const ready = once(server, 'listening', { signal: AbortSignal.timeout(5000) });
    server.listen(0, '127.0.0.1'); await ready;
    const port = server.address().port; assert.ok(!protectedPorts.has(port)); resources.push(port);
    return `http://127.0.0.1:${port}`;
  }
  try {
    const origin = await httpOrigin(), foreign = await httpOrigin();
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, timeout: 20000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
    resources.push(Number(new URL(browserServer.wsEndpoint()).port));
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
    async function contextFor(errors, demoMode = false) {
      const context = await browser.newContext({ serviceWorkers: 'block' }); contexts.push(context);
      await context.route('**/*', route => [origin, foreign].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
      await initializeDeadlineSession(context, { origin, session, demoMode, onPageError: error => errors.push(error.message) });
      return context;
    }
    const errors = [], context = await contextFor(errors, true);
    const page = await context.newPage();
    assert.equal(page.url(), 'about:blank');
    assert.equal(await page.evaluate(() => location.origin), 'null');
    assert.deepEqual(errors, []);
    await page.goto(foreign, { waitUntil: 'load', timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => [window.sessionAtStartup, localStorage.getItem('orbitflow.demoMode')]), [null, null]);
    await page.goto(origin, { waitUntil: 'load', timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => [JSON.parse(window.sessionAtStartup), localStorage.getItem('orbitflow.demoMode')]), [session, '0']);
    // Every page in a reused actor context must initialize before application scripts.
    const companion = await context.newPage();
    assert.equal(companion.url(), 'about:blank');
    await companion.goto(origin, { waitUntil: 'load', timeout: 15000 });
    assert.deepEqual(await companion.evaluate(() => JSON.parse(window.sessionAtStartup)), session);
    assert.deepEqual(errors, []);

    const captured = [], failingContext = await contextFor(captured);
    await failingContext.addInitScript(() => { if (location.origin === 'null') throw new Error('DEADLINE_CREATION_ERROR'); });
    // Subscribe before newPage: this failure occurs before any document navigation.
    const creationError = failingContext.waitForEvent('weberror', { predicate: event => event.error().message === 'DEADLINE_CREATION_ERROR', timeout: 15000 });
    const [failingPage, creation] = await Promise.all([failingContext.newPage(), creationError]);
    assert.equal(creation.page(), failingPage); assert.equal(failingPage.url(), 'about:blank');
    assert.deepEqual(captured, ['DEADLINE_CREATION_ERROR']);
    const runtimeError = failingContext.waitForEvent('weberror', { predicate: event => event.error().message === 'DEADLINE_AUTHORIZED_PAGE_ERROR', timeout: 15000 });
    await Promise.all([failingPage.goto(origin + '/error', { waitUntil: 'load', timeout: 15000 }), runtimeError]);
    assert.deepEqual(captured, ['DEADLINE_CREATION_ERROR', 'DEADLINE_AUTHORIZED_PAGE_ERROR']);
    assert.deepEqual(await failingPage.evaluate(() => [JSON.parse(localStorage.getItem('orbitflow.session.v1')), localStorage.getItem('orbitflow.demoMode')]), [session, null]);
    assert.equal(networkAudit.blocked.length, 0);
    console.log(JSON.stringify({ chrome: browser.version(), originlessClean: true, foreignSessionAbsent: true, authorizedSessionAtStartup: true, captured }));
  } finally {
    for (const context of contexts) await context.close();
    await browser?.close(); await browserServer?.close();
    for (const server of servers) if (server.listening) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    if (browserServer) {
      assert.ok(browserServer.process().exitCode !== null || browserServer.process().signalCode !== null);
      const profile = browserServer.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      assert.equal(existsSync(profile), false);
    }
    for (const port of resources) {
      assert.ok(!protectedPorts.has(port));
      const server = createServer();
      const ready = once(server, 'listening', { signal: AbortSignal.timeout(3000) });
      server.listen(port, '127.0.0.1'); await ready;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
