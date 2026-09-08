import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { startDeadlineServer } from './deadline-fixture.js';
import { exerciseConsumerBoundary } from './deadline-wiki-consumer-probes.js';

test('SQLite internal consumer boundary', {timeout:60000}, async t => {
  const api = await startDeadlineServer();
  try { await exerciseConsumerBoundary(t,api); }
  finally {
    await api.close();
    const evidence = new URL('../../.omo/evidence/task-31-revision/',import.meta.url);
    await mkdir(evidence,{recursive:true});
    await writeFile(new URL(`sqlite-consumer-${process.env.DEADLINE_RUN_ID}.json`,evidence),JSON.stringify({http:api.http,cleanup:api.resource},null,2));
  }
});
