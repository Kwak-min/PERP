import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier) ? specifier + '.ts' : specifier, context);
} });
const values = new Map();
Object.defineProperty(globalThis, 'sessionStorage', { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: { setItem() { assert.fail('Private continuation must never enter localStorage'); } }, configurable: true });
const load = () => import('../src/services/authTransition.ts');
const token = 'A'.repeat(43);
beforeEach(() => values.clear());

test('validated token syntax and return path survive auth and onboarding without persistent storage', async () => {
  const transition = await load();
  transition.captureAuthTransition(`?invite=${token}&next=${encodeURIComponent('/members?tab=active')}`);
  assert.deepEqual(transition.readAuthTransition(), { invite: token, next: '/members?tab=active' });
  transition.captureAuthTransition('');
  assert.equal(transition.readAuthTransition().invite, token);
  transition.clearInvitation();
  assert.equal(transition.consumeReturnPath(), '/members?tab=active');
  assert.deepEqual(transition.readAuthTransition(), { invite: null, next: null });
});

test('existing PG UUID invitation survives auth and pasted links without accepting arbitrary next URLs', async () => {
  const transition = await load(), pgToken = '12345678-1234-4234-8234-123456789abc';
  for (const code of [pgToken, token]) {
    assert.equal(transition.parseInvitationCode(`https://example.invalid/invitations?invite=${code}&next=https://evil.invalid`), code);
    transition.captureAuthTransition(`?invite=${code}&next=${encodeURIComponent('/members')}`);
    assert.equal(transition.readAuthTransition().invite, code);
    assert.equal(transition.consumeReturnPath(), '/members');
  }
  for (const value of ['https://example.invalid/?invite=%ZZ', 'javascript:alert(1)', '//evil.invalid', 'http://[', 'a'.repeat(501)]) assert.equal(transition.parseInvitationCode(value), null);
});

test('nested invitation return URL becomes token-free internal routing', async () => {
  const transition = await load();
  transition.captureAuthTransition(`?next=${encodeURIComponent(`/invitations?invite=${token}`)}`);
  assert.deepEqual(transition.readAuthTransition(), { invite: token, next: '/invitations' });
});

for (const value of ['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/%2f%2fevil.invalid', '/login', '/signup', '/members\n', 'javascript:alert(1)']) test(`rejects unsafe or looping return path ${JSON.stringify(value)}`, async () => {
  const transition = await load();
  transition.captureAuthTransition(`?next=${encodeURIComponent(value)}`);
  assert.equal(transition.readAuthTransition().next, null);
});

for (const value of ['not-a-valid-token', 'a'.repeat(501), 'https://evil.invalid', '<script>', 'A'.repeat(42) + '/']) test('rejects malformed invitation syntax: ' + value.length, async () => {
  const transition = await load();
  transition.captureAuthTransition(`?invite=${encodeURIComponent(value)}`);
  assert.equal(transition.readAuthTransition().invite, null);
});
