import assert from 'node:assert/strict';
import test from 'node:test';
import { personalWikiRoot, assertPersonalWikiRoute } from './task28-personal.scenario.mjs';

for (const mode of ['legacy', 'pg']) test(`personal workflow ${mode} route contract rejects company and other-store aliases`, () => {
  const root = mode === 'pg' ? '/pg/vault/wiki' : '/vault/wiki';
  assert.equal(personalWikiRoot(mode), root);
  for (const suffix of ['', '/sources', '/jobs/job/draft', '/change-sets/draft/publish', '/pages/page/history', '/events']) assert.equal(assertPersonalWikiRoute(mode, '/api/v1' + root + suffix), suffix);
  for (const wrong of ['/api/v1/documents/wiki/jobs', '/api/v1/pg/documents/wiki/jobs', '/api/v1' + root + '-alias/jobs', '/api/v1' + personalWikiRoot(mode === 'pg' ? 'legacy' : 'pg') + '/jobs']) assert.throws(() => assertPersonalWikiRoute(mode, wrong), assert.AssertionError);
});
test('personal workflow rejects unspecified or invented stores instead of defaulting company', () => {
  for (const mode of [undefined, null, '', 'company', 'sqlite', 'native']) assert.throws(() => personalWikiRoot(mode), assert.AssertionError);
});
