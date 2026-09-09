import assert from 'node:assert/strict';
import test, { before, beforeEach, after } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';

const pgToken = '11111111-1111-4111-8111-111111111111';
const user = { id: 'synthetic-user', name: 'Recovery QA', email: 'recovery@example.invalid' };
const pg = { token: pgToken, user };
const legacy = { access_token: 'synthetic-legacy-session', user, must_change_password: true };
const orgs = [{ org_id: 'pg:1', org_name: 'QA', org_type: 'company', roles: ['member'] }];
const error = (status, code) => ({ status, body: { error: { code, message: code, details: {}, request_id: 'synthetic-request' } } });
let routes, requests, auth, store, api, server;
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), clear: () => values.clear() }; };
Object.defineProperty(globalThis, 'localStorage', { value: storage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: storage(), configurable: true });

before(async () => {
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const result = routes.get(req.url) ?? error(500, 'UNEXPECTED_ENDPOINT');
    if (result.disconnect) { req.socket.destroy(); return; }
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const base = `http://127.0.0.1:${server.address().port}`;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
      return next(specifier, context);
    },
    load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/services/api.ts')) return { ...result, source: String(result.source).replace('import.meta.env.VITE_API_BASE_URL', JSON.stringify(base)) };
      return result;
    },
  });
  auth = await import('../src/services/auth.ts');
  store = (await import('../src/store/session.ts')).sessionStore;
  api = await import('../src/services/api.ts');
});
beforeEach(() => { routes = new Map(); requests = []; store.clear(); sessionStorage.clear(); });
after(async () => { await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });

for (const operation of ['signup', 'login']) test(`${operation} keeps the authenticated identity across workspace 503 and retries only lookup`, async () => {
  // Given: account/session creation succeeds independently of workspace availability.
  routes.set(`/pg/auth/${operation}`, { status: operation === 'signup' ? 201 : 200, body: pg });
  routes.set('/pg/auth/workspace', error(503, 'SERVICE_UNAVAILABLE'));
  // When: the screen saves authentication before loading organizations.
  const session = operation === 'signup' ? await auth.signup(user.email, user.name, 'synthetic-password') : await auth.login(user.email, 'synthetic-password');
  store.set(session, false);
  assert.equal(requests.length, 1);
  await assert.rejects(auth.loadSessionOrganizations(pgToken), err => err instanceof api.ApiError && err.status === 503);
  // Then: no false empty result, lost token, legacy fallback, or duplicate signup.
  assert.equal(store.getSnapshot().token, pgToken);
  assert.equal(store.getSnapshot().organizationStatus, 'loading');
  assert.equal(localStorage.getItem('orbitflow.session.v1'), null);
  routes.set('/pg/auth/workspace', { body: { organizations: orgs } });
  await auth.loadSessionOrganizations(pgToken);
  assert.equal(store.getSnapshot().organizationStatus, 'ready');
  assert.equal(store.getSnapshot().orgId, 'pg:1');
  assert.deepEqual(store.getSnapshot().organizations, orgs);
  assert.deepEqual(requests.map(req => req.path), [`/pg/auth/${operation}`, '/pg/auth/workspace', '/pg/auth/workspace']);
  assert.equal(requests[1].authorization, `Bearer ${pgToken}`);
});

for (const [status, code] of [[503, 'SERVICE_UNAVAILABLE'], [500, 'INTERNAL_ERROR'], [502, 'SERVICE_UNAVAILABLE'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [401, 'OTHER_AUTH_ERROR']]) test(`PG ${status}/${code} never consults legacy credentials`, async () => {
  routes.set('/pg/auth/login', error(status, code)); routes.set('/auth/login', { body: legacy });
  await assert.rejects(auth.login(user.email, 'synthetic-password'), err => err instanceof api.ApiError && err.status === status && err.code === code);
  assert.deepEqual(requests.map(req => req.path), ['/pg/auth/login']);
  assert.equal(store.getSnapshot(), null);
});

test('PG network failure never consults legacy credentials', async () => {
  routes.set('/pg/auth/login', { disconnect: true }); routes.set('/auth/login', { body: legacy });
  await assert.rejects(auth.login(user.email, 'synthetic-password'), TypeError);
  assert.deepEqual(requests.map(req => req.path), ['/pg/auth/login']);
});

test('genuine PG credential rejection permits independently authenticated legacy identity', async () => {
  routes.set('/pg/auth/login', error(401, 'UNAUTHENTICATED')); routes.set('/auth/login', { body: legacy });
  const session = await auth.login(user.email, 'synthetic-password');
  assert.equal(session.token, legacy.access_token); assert.equal(session.mustChangePassword, true);
  assert.deepEqual(requests.map(req => req.path), ['/pg/auth/login', '/auth/login']);
});

test('both stores rejecting credentials does not create a session', async () => {
  routes.set('/pg/auth/login', error(401, 'UNAUTHENTICATED')); routes.set('/auth/login', error(401, 'UNAUTHENTICATED'));
  await assert.rejects(auth.login(user.email, 'synthetic-password'), err => err instanceof api.ApiError && err.status === 401);
  assert.deepEqual(requests.map(req => req.path), ['/pg/auth/login', '/auth/login']); assert.equal(store.getSnapshot(), null);
});

test('signup never accepts an invitation inside account creation', async () => {
  routes.set('/pg/auth/signup', { status: 201, body: pg });
  const session = await auth.signup(user.email, user.name, 'synthetic-password', 'synthetic-invitation');
  assert.equal(session.token, pgToken); assert.deepEqual(requests.map(req => req.path), ['/pg/auth/signup']);
  assert.equal(requests[0].body.invitation_token, undefined);
});

for (const [label, invitation, endpoint, payload] of [
  ['SQLite', 'A'.repeat(43), '/auth', legacy],
  ['PostgreSQL', pgToken, '/pg/auth', pg],
]) {
  test(`${label} invitation login selects its store even with identical credentials in both stores`, async () => {
    routes.set('/pg/auth/login', { body: pg }); routes.set('/auth/login', { body: legacy });
    const session = await auth.login(user.email, 'synthetic-password', invitation);
    assert.equal(session.token, payload.token ?? payload.access_token);
    assert.deepEqual(requests.map(req => req.path), [`${endpoint}/login`]);
  });
  test(`${label} invitation credential rejection never falls through to the other store`, async () => {
    routes.set('/pg/auth/login', { body: pg }); routes.set('/auth/login', { body: legacy });
    routes.set(`${endpoint}/login`, error(401, 'UNAUTHENTICATED'));
    await assert.rejects(auth.login(user.email, 'synthetic-password', invitation), err => err instanceof api.ApiError && err.status === 401);
    assert.deepEqual(requests.map(req => req.path), [`${endpoint}/login`]);
  });
  test(`${label} invitation signup creates only an account in its store`, async () => {
    routes.set('/pg/auth/signup', { status: 201, body: pg }); routes.set('/auth/signup', { status: 201, body: legacy });
    const session = await auth.signup(user.email, user.name, 'synthetic-password', invitation);
    assert.equal(session.token, payload.token ?? payload.access_token);
    assert.deepEqual(requests.map(req => req.path), [`${endpoint}/signup`]);
    assert.equal(requests[0].body.invitation_token, undefined);
  });
}

test('saved organization selection is only a hint until fresh membership validates it', async () => {
  store.set({ token: 'old', orgId: 'pg:2', name: user.name, email: user.email, mustChangePassword: false, organizations: [] });
  routes.set('/pg/auth/login', { body: pg });
  store.set(await auth.login(user.email, 'synthetic-password'));
  assert.equal(store.getSnapshot().orgId, null);
  routes.set('/pg/auth/workspace', { body: { organizations: [...orgs, { ...orgs[0], org_id: 'pg:2' }] } });
  await auth.loadSessionOrganizations(pgToken);
  assert.equal(store.getSnapshot().orgId, 'pg:2');
});
