import {test} from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {startDeadlineServer} from './deadline-fixture.js';
import {sseScenarios} from './deadline-wiki-sse-scenarios.js';
test('SQLite real app/exported SSE regressions',{timeout:120000},async t=>{
  const api=await startDeadlineServer();
  try{await sseScenarios(t,api);}
  finally{await api.close();const evidence=new URL('../../.omo/evidence/task-33-sse-revision/',import.meta.url);await mkdir(evidence,{recursive:true});await writeFile(new URL('sqlite.json',evidence),JSON.stringify({http:api.http,cleanup:api.resource},null,2));}
});
