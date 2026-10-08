import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { registerHooks } from 'node:module';

// Node의 TS 실행도 브라우저와 같은 실제 catalog 모듈을 읽는다.
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === '../routes/catalog' ? new URL('../src/routes/catalog.ts', import.meta.url).href : specifier, context);
} });
const pref = await import('../src/store/navPref.ts');
const { screens, navigation } = await import('../src/routes/catalog.ts');
const A = { userId: 'actor-a', source: 'legacy', orgId: 'company-a' };
const value = (favorites = [], collapsed = [], hidden = []) => ({ version: 1, favoriteScreenIds: favorites, collapsedSectionIds: collapsed, hiddenScreenIds: hidden });
let values;
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, item) => values.set(key, String(item)),
  } });
});

test('project and task navigation retain distinct screen IDs, routes and modules', () => {
  assert.deepEqual(navigation.filter(screen => ['PRJ-001', 'TSK-001'].includes(screen.id)).map(({ id, path, module }) => ({ id, path, module })), [
    { id: 'PRJ-001', path: '/projects', module: 'projects' }, { id: 'TSK-001', path: '/tasks', module: 'tasks' },
  ]);
});

test('version 1 order and collapsed IDs survive a fresh read, without storing private fields', () => {
  const input = { ...value(['CAL-001', 'PRJ-001'], ['work', 'people']), token: 'SYNTHETIC_SECRET', title: 'PRIVATE_NOTE', record: { id: 'PRIVATE_ID' } };
  const written = pref.writeNavPref(A, input);
  assert.deepEqual(written, value(['CAL-001', 'PRJ-001'], ['work', 'people']));
  assert.deepEqual(pref.readNavPref(A), { status: 'ready', value: written });
  assert.deepEqual(JSON.parse(values.get(pref.navPrefKey(A))), written);
  assert.equal([...values.values()].join('').includes('PRIVATE'), false);
  assert.equal([...values.values()].join('').includes('SYNTHETIC_SECRET'), false);
});

test('user, source and company are independent, delimiter-safe identities', () => {
  const scopes = [A, { ...A, userId: 'actor-b' }, { ...A, source: 'pg' }, { ...A, orgId: 'company-b' },
    { ...A, userId: 'a:b', orgId: 'c' }, { ...A, userId: 'a', orgId: 'b:c' }];
  assert.equal(new Set(scopes.map(pref.navPrefKey)).size, scopes.length);
  scopes.forEach((scope, index) => pref.writeNavPref(scope, value([screens[index].id])));
  scopes.forEach((scope, index) => assert.deepEqual(pref.readNavPref(scope).value, value([screens[index].id])));
  assert.deepEqual(pref.readNavPref({ ...A, orgId: 'new' }), { status: 'empty', value: value() });
});

test('untrusted values normalize duplicates, unknown IDs, wrong types and extra fields in stable order', () => {
  const malformed = { ...value(['PRJ-001', 'removed', 'CAL-001', 'PRJ-001', null, {}, '/projects', '__proto__'], ['work', 'work', 'no-section', 4, 'people']), extra: 'private' };
  assert.deepEqual(pref.normalizeNavPref(malformed), value(['PRJ-001', 'CAL-001'], ['work', 'people']));
  for (const input of [null, [], true, 'json', 42, {}, { version: 2, favoriteScreenIds: ['PRJ-001'] }, { version: '1' }]) {
    assert.deepEqual(pref.normalizeNavPref(input), value());
  }
  assert.deepEqual(pref.normalizeNavPref({ version: 1, favoriteScreenIds: {}, collapsedSectionIds: 'work' }), value());
});

test('corrupt JSON and unsupported records are recoverable without a read-time rewrite', () => {
  for (const raw of ['{', 'null', '[]', '{"version":2}', '{"version":"1"}']) {
    values.set(pref.navPrefKey(A), raw);
    assert.deepEqual(pref.readNavPref(A), { status: 'invalid', value: value() });
    assert.equal(values.get(pref.navPrefKey(A)), raw);
    pref.writeNavPref(A, value(['PRJ-001']));
    assert.deepEqual(pref.readNavPref(A), { status: 'ready', value: value(['PRJ-001']) });
  }
});

test('revoked grants and disabled modules hide favorites without erasing their stored positions', () => {
  pref.writeNavPref(A, value(['AST-001', 'CAL-001', 'PRJ-001']));
  const before = values.get(pref.navPrefKey(A));
  const visible = screens.filter(screen => screen.id === 'PRJ-001');
  assert.deepEqual(pref.selectNavFavorites(pref.readNavPref(A).value, visible).map(screen => screen.id), ['PRJ-001']);
  assert.equal(values.get(pref.navPrefKey(A)), before);
  assert.deepEqual(pref.selectNavFavorites(pref.readNavPref(A).value, screens).map(screen => screen.id), ['AST-001', 'CAL-001', 'PRJ-001']);
});

test('removed and non-nav IDs never project, even when the caller supplies them as visible', () => {
  const input = value(['PRJ-002', 'removed', 'PRJ-001', 'PRJ-001']);
  assert.deepEqual(pref.selectNavFavorites(input, [...screens, { id: 'removed', nav: true }]).map(screen => screen.id), ['PRJ-001']);
  assert.deepEqual(pref.selectNavFavorites(input, []), []);
});

test('functional updates use the latest storage and explicit scope, retaining hidden favorites', () => {
  pref.writeNavPref(A, value(['AST-001', 'PRJ-001']));
  const B = { ...A, orgId: 'company-b' };
  pref.writeNavPref(B, value(['CAL-001']));
  pref.updateNavPref(A, current => ({ ...current, collapsedSectionIds: ['work'] }));
  pref.updateNavPref(A, current => ({ ...current, favoriteScreenIds: [...current.favoriteScreenIds].reverse() }));
  assert.deepEqual(pref.readNavPref(A).value, value(['PRJ-001', 'AST-001'], ['work']));
  assert.deepEqual(pref.readNavPref(B).value, value(['CAL-001']));
  assert.throws(() => pref.updateNavPref(A, () => { throw new Error('cancelled edit'); }), /cancelled edit/);
  assert.deepEqual(pref.readNavPref(A).value, value(['PRJ-001', 'AST-001'], ['work']));
});

test('missing authenticated identity or workspace cannot read or write a shared fallback key', () => {
  for (const scope of [null, {}, { ...A, userId: '' }, { ...A, userId: ' ' }, { ...A, orgId: null }, { ...A, source: 'unknown' }]) {
    assert.throws(() => pref.navPrefKey(scope), TypeError);
    assert.throws(() => pref.writeNavPref(scope, value()), TypeError);
  }
  assert.equal(values.size, 0);
});

test('storage access and quota failures are explicit and never claim a successful save', () => {
  const denied = new DOMException('storage denied', 'SecurityError');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw denied; } });
  assert.deepEqual(pref.readNavPref(A), { status: 'unavailable', value: value(), error: denied });
  assert.throws(() => pref.writeNavPref(A, value()), error => error === denied);
  assert.throws(() => pref.updateNavPref(A, current => current), error => error === denied);
  const quota = new DOMException('full', 'QuotaExceededError');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: () => null, setItem() { throw quota; } } });
  assert.throws(() => pref.writeNavPref(A, value(['PRJ-001'])), error => error === quota);
});

test('old version-one bytes upgrade only on explicit writes and retain favorites and collapse order', () => {
  const old = JSON.stringify({ version: 1, favoriteScreenIds: ['CAL-001', 'PRJ-001'], collapsedSectionIds: ['people', 'work'] });
  values.set(pref.navPrefKey(A), old);
  assert.deepEqual(pref.readNavPref(A).value, value(['CAL-001', 'PRJ-001'], ['people', 'work']));
  assert.equal(values.get(pref.navPrefKey(A)), old);
  pref.updateNavPref(A, current => ({ ...current, hiddenScreenIds: ['PRJ-001'] }));
  assert.deepEqual(pref.readNavPref(A).value, value(['CAL-001', 'PRJ-001'], ['people', 'work'], ['PRJ-001']));
  assert.deepEqual(pref.selectNavFavorites(pref.readNavPref(A).value, screens).map(screen => screen.id), ['CAL-001']);
  pref.updateNavPref(A, current => ({ ...current, hiddenScreenIds: [] }));
  assert.deepEqual(pref.selectNavFavorites(pref.readNavPref(A).value, screens).map(screen => screen.id), ['CAL-001', 'PRJ-001']);
});

test('personal hiding validates navigable IDs, keeps home safe and remains scope-local', () => {
  const home = screens.find(screen => screen.path === '/');
  const input = value(['PRJ-001'], ['work'], ['PRJ-001', home.id, 'PRJ-002', 'removed', null, 'PRJ-001']);
  pref.writeNavPref(A, input);
  assert.deepEqual(pref.readNavPref(A).value, value(['PRJ-001'], ['work'], ['PRJ-001']));
  assert.deepEqual(pref.readNavPref({ ...A, orgId: 'company-b' }).value.hiddenScreenIds, []);
  assert.deepEqual(pref.readNavPref({ ...A, source: 'pg' }).value.hiddenScreenIds, []);
  assert.deepEqual(pref.readNavPref({ ...A, userId: 'actor-b' }).value.hiddenScreenIds, []);
  assert.deepEqual(pref.normalizeNavPref({ ...input, hiddenScreenIds: {} }).hiddenScreenIds, []);
});

test('read values have no shared mutable default state', () => {
  const first = pref.readNavPref(A).value;
  first.favoriteScreenIds.push('PRJ-001');
  assert.deepEqual(pref.readNavPref(A).value, value());
});
