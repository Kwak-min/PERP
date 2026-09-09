import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { startDeadlineServer } from './deadline-fixture.js';
import { startOrgPostgres } from './pg-org-native-fixture.js';
import { exerciseSources, exerciseRetrieval } from './deadline-wiki-fixture.js';
import { exerciseAuthorization } from './deadline-wiki-authorization.js';

test('native PostgreSQL18: additive Wiki schema and scoped HTTP', { timeout: 120000 }, async () => {
  const api = await startDeadlineServer();
  let native;
  const nativeResource = {data:null,port:null,engine:null,stopped:false,removed:false};
  const evidence = new URL(`../../.omo/evidence/task-31-revision/storage-${process.env.DEADLINE_RUN_ID}/`, import.meta.url);
  await mkdir(evidence, { recursive: true });
  try {
    native = await startOrgPostgres();
    const { pgPool } = await import('../src/config/pg.js');
    Object.assign(pgPool.options, { host: '127.0.0.1', port: Number(process.env.PG_PORT), database: 'postgres', user: 'org_test', password: '', connectionTimeoutMillis: 5000 });
    for (const file of ['perp_additions_v11_deadline_roles.sql', 'perp_additions_v9_daily_corrections.sql', 'perp_additions_v15_knowledge_wiki.sql']) {
      await native.pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    }
    nativeResource.engine = (await native.pool.query('SELECT version()')).rows[0].version;
    nativeResource.data = (await native.pool.query('SHOW data_directory')).rows[0].data_directory;
    nativeResource.port = Number(process.env.PG_PORT);
    assert.match(nativeResource.engine, /PostgreSQL 18/);
    assert.equal((await native.pool.query('SELECT count(*)::int AS n FROM knowledge.wiki')).rows[0].n, 0);
    const fixture = await exerciseSources(api,'/pg','native');
    await exerciseRetrieval(api,fixture,'/pg');
    await exerciseAuthorization(api,fixture,'/pg');
    await assert.rejects(native.pool.query("UPDATE knowledge.source_revision SET title='tampered'"),/immutable/);
    await assert.rejects(native.pool.query('DELETE FROM knowledge.source_revision'),/immutable/);
    for (const scope of ['personal','company']) await assert.rejects(native.pool.query("INSERT INTO knowledge.wiki(id,store,scope,tenant_id,company_id,owner_id,created_at) SELECT id||'-duplicate',store,scope,tenant_id,company_id,owner_id,created_at FROM knowledge.wiki WHERE scope=$1 LIMIT 1",[scope]),error=>error.code==='23505');
    const personal = (await native.pool.query("SELECT * FROM knowledge.wiki WHERE scope='personal'")).rows;
    assert.equal(personal.length,1); assert.equal(personal[0].company_id,null); assert.equal(personal[0].tenant_id,null);
    const second = await api.request(fixture.a,'/pg/companies','POST',{name:'same-owner-second-company',modules:['documents'],features:[],departments:[]},201);
    const fromA = await api.request(fixture.a,'/pg/vault/wiki');
    const fromSecond = await api.request({...fixture.a,orgId:second.org_id},'/pg/vault/wiki');
    assert.equal(fromA.wiki.id,fromSecond.wiki.id);
  } finally {
    try { await api.close(); }
    finally {
      if (native) { await native.close(); nativeResource.stopped = true; nativeResource.removed = !existsSync(nativeResource.data); }
      await writeFile(new URL('pg-http.json', evidence), JSON.stringify({ http: api.http, cleanup: api.resource, nativeResource }, null, 2));
    }
  }
});
