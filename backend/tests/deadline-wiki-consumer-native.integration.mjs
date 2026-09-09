import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startDeadlineServer } from './deadline-fixture.js';
import { startOrgPostgres } from './pg-org-native-fixture.js';
import { exerciseConsumerBoundary } from './deadline-wiki-consumer-probes.js';

test('native PostgreSQL18 internal consumer boundary', {timeout:120000}, async t => {
  const api = await startDeadlineServer();
  let native;
  const resource = {};
  try {
    native = await startOrgPostgres();
    const {pgPool} = await import('../src/config/pg.js');
    Object.assign(pgPool.options,{host:'127.0.0.1',port:Number(process.env.PG_PORT),database:'postgres',user:'org_test',password:'',connectionTimeoutMillis:5000});
    for (const file of ['perp_additions_v11_deadline_roles.sql','perp_additions_v9_daily_corrections.sql','perp_additions_v15_knowledge_wiki.sql']) await native.pool.query(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));
    resource.engine = (await native.pool.query('SELECT version()')).rows[0].version;
    resource.data = (await native.pool.query('SHOW data_directory')).rows[0].data_directory;
    resource.port = Number(process.env.PG_PORT);
    assert.match(resource.engine,/PostgreSQL 18/);
    await exerciseConsumerBoundary(t,api,'/pg');
  } finally {
    try { await api.close(); }
    finally {
      if (native) { await native.close(); resource.removed = !existsSync(resource.data); }
      const evidence = new URL('../../.omo/evidence/task-31-revision/',import.meta.url);
      await mkdir(evidence,{recursive:true});
      await writeFile(new URL(`pg-consumer-${process.env.DEADLINE_RUN_ID}.json`,evidence),JSON.stringify({http:api.http,cleanup:api.resource,native:resource},null,2));
    }
  }
});
