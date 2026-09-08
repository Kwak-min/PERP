import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { observeApiResponses, captureJsonResponse } from './deadline-approval-responses.mjs';

test('Chrome captures required bodies before navigation, classifies cancelled incidental reads, and propagates invalid assertion JSON', async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const release = Promise.withResolvers();
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/required') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
      release.promise.then(() => response.end(JSON.stringify({ id: '9007199254740993', version: 12 })));
    } else if (request.url === '/api/v1/incidental') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
      // Deliberately unfinished until navigation cancels it; no timer races.
    } else if (request.url === '/api/v1/invalid') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('invalid-json');
    } else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Response boundary</title>'); }
  });
  let browser;
  try {
    const listening = once(server, 'listening', { signal: AbortSignal.timeout(15000) }); server.listen(0, '127.0.0.1'); await listening;
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking','--disable-component-update','--disable-sync'] });
    const page = await browser.newPage(); page.setDefaultTimeout(15000);
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    const result = { http: [], errors: [] }; observeApiResponses(page, { id: 'fixture' }, result);
    await page.goto(origin);
    const required = captureJsonResponse(page, response => response.url() === origin + '/api/v1/required', result);
    const headers = page.waitForResponse(response => response.url() === origin + '/api/v1/required');
    await page.evaluate(() => { window.requiredBody = fetch('/api/v1/required').then(response => response.json()); });
    await headers; release.resolve(); const captured = await required;
    assert.equal(captured.response.status(), 200); assert.deepEqual(captured.body, { id: '9007199254740993', version: 12 });
    assert.deepEqual(await page.evaluate(() => window.requiredBody), captured.body);
    const incidental = page.waitForResponse(response => response.url() === origin + '/api/v1/incidental');
    await page.evaluate(() => { window.cancelIncidental = new AbortController(); window.incidental = fetch('/api/v1/incidental', { signal: window.cancelIncidental.signal }).then(response => response.text()).catch(error => error.name); });
    await incidental;
    const cancelled = page.waitForEvent('requestfailed', { predicate: request => request.url() === origin + '/api/v1/incidental' });
    await page.evaluate(() => window.cancelIncidental.abort()); await cancelled;
    await page.goto(origin + '/next');
    assert.deepEqual(captured.body, { id: '9007199254740993', version: 12 });
    const observation = result.http.find(row => row.route === '/api/v1/incidental');
    assert.equal(observation.observation, 'cancelled'); assert.equal(Object.hasOwn(observation, 'body'), false);
    const invalid = captureJsonResponse(page, response => response.url() === origin + '/api/v1/invalid', result);
    const rejection = assert.rejects(invalid, error => error.message.includes('GET /api/v1/invalid') && error.cause instanceof Error);
    await page.evaluate(() => fetch('/api/v1/invalid').then(response => response.text())); await rejection;
    assert.equal(result.http.some(row => row.route === '/api/v1/invalid' && row.observation === 'required-body'), false);
    assert.deepEqual(result.errors, []);
    console.log(JSON.stringify({ chrome: browser.version(), required: captured.body, cancelled: observation, invalidAssertionRejected: true }));
  } finally {
    release.resolve(); await browser?.close();
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
});
