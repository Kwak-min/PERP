import assert from 'node:assert/strict';

export const insecureOriginRequested = process.argv.includes('--insecure-origin');
export const browserFixtureOrigin = port => `http://${insecureOriginRequested ? 'erp.test' : '127.0.0.1'}:${port}`;
// 브라우저 origin은 HTTP erp.test로 유지하고 DNS/외부 접속 없이 fixture에만 중계한다.
export function fixtureFetch(route) {
  const url = new URL(route.request().url());
  assert.ok(['erp.test', '127.0.0.1'].includes(url.hostname));
  url.hostname = '127.0.0.1';
  return route.fetch({ url: url.href });
}
export async function routeFixture(context, origin) {
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    if (!insecureOriginRequested) return route.continue();
    return route.fulfill({ response: await fixtureFetch(route) });
  });
}
export async function assertFixtureSecurity(page) {
  const state = await page.evaluate(() => ({ origin: location.origin, secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues }));
  if (insecureOriginRequested) {
    assert.equal(new URL(state.origin).hostname, 'erp.test');
    assert.equal(state.secure, false);
    assert.equal(state.uuid, 'undefined');
    assert.equal(state.random, 'function');
  }
  return state;
}
