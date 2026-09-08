import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

test('Given reservation error envelopes over HTTP, when using the actual API adapter, then retain status/code/details and message', async () => {
  let payload, status;
  const server = createServer((_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); });
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await ready;
  try {
    const result = await build({ configFile: false, envFile: false, logLevel: 'error', define: { 'import.meta.env.VITE_RESERVATION_API_URL': JSON.stringify(`http://127.0.0.1:${server.address().port}`) }, build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL('./reservationApi.ts', import.meta.url)), formats: ['es'] } } });
    const api = await import(`data:text/javascript;base64,${Buffer.from(result[0].output[0].code).toString('base64')}`);
    for (const value of [400, 403, 409, 500, 503]) {
      status = value;
      for (const envelope of ['legacy', 'extended', 'nested']) {
        const fields = { code: `HTTP_${value}`, message: `fixture-${envelope}-${value}`, details: { field: 'startTime' } };
        payload = envelope === 'legacy' ? { success: false, message: fields.message } : envelope === 'extended' ? fields : { error: fields };
        await assert.rejects(api.getReservations(), error => {
          assert.equal(error.message, fields.message);
          assert.equal(error.status, value);
          assert.equal(error.code, fields.code);
          assert.deepEqual(error.details, envelope === 'legacy' ? undefined : fields.details);
          return true;
        });
      }
    }
  } finally {
    const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); server.closeAllConnections(); await closed;
  }
});
