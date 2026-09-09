import test from 'node:test';
import { analyticsFixture } from './analytics-http-fixture.js';
import { analyticsCases } from './analytics-http-cases.js';

test('SQLite analytics HTTP boundaries', async t => {
  const fixture = await analyticsFixture(false);
  try { await analyticsCases(t, fixture); }
  finally { await fixture.close(); }
});
