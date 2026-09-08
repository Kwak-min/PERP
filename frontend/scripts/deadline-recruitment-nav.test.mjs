import assert from 'node:assert/strict';
import test from 'node:test';
import { allRoutePaths, navigation, screens } from '../src/routes/catalog.ts';

test('recruitment remains directly routable with its existing API and permission contract', () => {
  // Given: the existing recruitment screen identity.
  // When: resolving the catalog independently of sidebar visibility.
  const screen = screens.find(item => item.id === 'HR-004');
  // Then: routing and access metadata are preserved, not feature-disabled.
  assert.ok(screen);
  assert.equal(screen.path, '/hr/recruitment');
  assert.equal(screen.endpoint, '/pg/hr/postings');
  assert.equal(screen.permission, 'menu.recruitment');
  assert.equal(screen.module, 'hr');
  assert.equal(screen.section, 'people');
  assert.equal(screen.feature, undefined);
  assert.equal(allRoutePaths.filter(path => path === screen.path).length, 1);
});

test('authorized navigation excludes recruitment and every non-nav screen', () => {
  // Given: the unfiltered navigation source, before any actor permission filter.
  // When: resolving navigation by stable screen ID.
  const ids = navigation.map(screen => screen.id);
  // Then: even a fully authorized consumer cannot render a non-nav shortcut.
  assert.equal(screens.find(screen => screen.id === 'HR-004')?.nav, false);
  assert.equal(ids.includes('HR-004'), false);
  for (const screen of screens.filter(screen => !screen.nav)) assert.equal(ids.includes(screen.id), false);
  assert.ok(ids.includes('ORG-002'));
});
