import {test} from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {startDeadlineServer} from './deadline-fixture.js';
import {publicationScenarios} from './deadline-wiki-publication-scenarios.js';
import {invalidationScenarios} from './deadline-wiki-publication-invalidation.js';
import {httpScenarios} from './deadline-wiki-publication-http.js';
import {authorizationScenarios} from './deadline-wiki-publication-authorization.js';
test('SQLite: explicit atomic publication, replay, concurrent CAS and inherited lineage',{timeout:120000},async()=>{
  const api=await startDeadlineServer();
  const evidence=new URL('../../.omo/evidence/task-33-deadline-erp-redesign/',import.meta.url);
  await mkdir(evidence,{recursive:true});
  try {const fixture=await publicationScenarios(api);await invalidationScenarios(api,fixture);await httpScenarios(api,fixture);await authorizationScenarios(api,fixture);}
  finally {await api.close();await writeFile(new URL('sqlite-http-db.json',evidence),JSON.stringify({http:api.http,cleanup:api.resource},null,2));}
});
