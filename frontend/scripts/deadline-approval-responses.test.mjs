import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeApiResponses } from './deadline-approval-responses.mjs';

// A navigation invalidates incidental response bodies in Chrome. Observations must
// not acquire those bodies at all; required assertions own their separate capture.
test('incidental JSON across navigation is metadata, not a deferred body assertion', async () => {
  const page = new EventEmitter(), result = { http: [], errors: [] }; let reads = 0;
  const response = { url: () => 'http://127.0.0.1:12345/api/v1/pg/approvals', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), json: async () => { reads++; throw new Error('Network.getResponseBody: No data found for resource with given identifier'); } };
  const request = { url: response.url, method: () => 'GET', headers: () => ({}), response: async () => response }; response.request = () => request;
  observeApiResponses(page, { id: '1' }, result);
  page.emit('request', request); page.emit('response', response);
  assert.equal(reads, 0); assert.deepEqual(result.errors, []);
  assert.equal(result.http[0].observation, 'incidental'); assert.equal(Object.hasOwn(result.http[0], 'body'), false);
});

test('cancelled requests and original downloads are explicitly classified without fake bodies', async () => {
  const page = new EventEmitter(), result = { http: [], errors: [] };
  const cancelled = { url: () => 'http://127.0.0.1:12345/api/v1/pg/approvals/1', method: () => 'GET', headers: () => ({}), response: async () => null, failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
  const request = { ...cancelled, url: () => 'http://127.0.0.1:12345/api/v1/pg/approvals/1/receipts/2' };
  const response = { request: () => request, url: request.url, status: () => 200, headers: () => ({ 'content-type': 'application/pdf' }) }; request.response = async () => response;
  observeApiResponses(page, { id: '1' }, result);
  page.emit('request', cancelled); page.emit('requestfailed', cancelled);
  page.emit('request', request); page.emit('response', response);
  assert.deepEqual(result.http.map(row => row.observation), ['cancelled', 'download']);
  assert.ok(result.http.every(row => !Object.hasOwn(row, 'body'))); assert.deepEqual(result.errors, []);
});
