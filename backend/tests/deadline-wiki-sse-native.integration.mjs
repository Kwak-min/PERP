import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {startDeadlineServer} from './deadline-fixture.js';
import {startOrgPostgres} from './pg-org-native-fixture.js';
import {sseScenarios} from './deadline-wiki-sse-scenarios.js';
test('native PostgreSQL18 real app/exported SSE regressions',{timeout:120000},async t=>{
  const api=await startDeadlineServer();let native;const resource={};
  try{
    native=await startOrgPostgres();
    const {pgPool}=await import('../src/config/pg.js');
    Object.assign(pgPool.options,{host:'127.0.0.1',port:Number(process.env.PG_PORT),database:'postgres',user:'org_test',password:'',connectionTimeoutMillis:5000});
    for(const file of ['perp_additions_v11_deadline_roles.sql','perp_additions_v9_daily_corrections.sql','perp_additions_v15_knowledge_wiki.sql','perp_additions_v18_knowledge_invalidation.sql'])await native.pool.query(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));
    resource.engine=(await native.pool.query('SELECT version()')).rows[0].version;assert.match(resource.engine,/PostgreSQL 18/);
    resource.data=(await native.pool.query('SHOW data_directory')).rows[0].data_directory;resource.port=Number(process.env.PG_PORT);
    await sseScenarios(t,api,'/pg');
  }finally{
    try{await api.close();}finally{if(native){await native.close();resource.stopped=true;resource.removed=!existsSync(resource.data);}
      const evidence=new URL('../../.omo/evidence/task-33-sse-revision/',import.meta.url);await mkdir(evidence,{recursive:true});await writeFile(new URL('native.json',evidence),JSON.stringify({http:api.http,cleanup:api.resource,native:resource},null,2));}
  }
});
