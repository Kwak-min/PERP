import assert from 'node:assert/strict';
import { test } from 'node:test';

test('graph navigation drains the response body before navigation discards it', async () => {
  const { graphResponseBody } = await import('./graph-response.mjs');
  const response = Promise.withResolvers(), drained = Promise.withResolvers();
  let disposed = false, subscribed = false;
  const page = { waitForEvent(event) { assert.equal(event, 'requestfinished'); subscribed = true; return response.promise; } };
  const body = graphResponseBody(page, () => true);
  assert.equal(subscribed, true);
  const navigation = (async () => {
    response.resolve({ response: async () => ({ status: () => 200, json: async () => {
      assert.equal(disposed, false, 'body read after navigation disposal');
      drained.resolve();
      return { nodes: [], edges: [] };
    } }) });
    const timeout = AbortSignal.timeout(1000);
    await Promise.race([drained.promise, new Promise((_, reject) => timeout.addEventListener('abort', () => reject(timeout.reason), { once: true }))]);
    disposed = true;
  })();
  await navigation;
  assert.deepEqual(await body, { status: 200, body: { nodes: [], edges: [] } });
});
