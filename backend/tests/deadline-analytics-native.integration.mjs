import test from 'node:test';
import { analyticsFixture } from './analytics-http-fixture.js';
import { analyticsCases } from './analytics-http-cases.js';

// 별도 isolated invocation: 두 native entry point를 같은 SQLite singleton 경로에서 병렬 실행하지 않는다.
test('native PostgreSQL18 analytics HTTP boundaries', async t => {
  const fixture = await analyticsFixture(true);
  try { await analyticsCases(t, fixture); }
  finally { await fixture.close(); }
});
