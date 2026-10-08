import {test} from 'node:test';
import assert from 'node:assert/strict';
import {personalCloudScenario} from './personal-cloud-scenarios.js';
test('SQLite personal graph and Wiki require exact scoped approval', {timeout:120000},()=>personalCloudScenario('legacy'));
test('Wiki consent envelope rejects absent or non-object HTTP bodies at validation boundary',async()=>{
 const {admitWikiJob}=await import('../src/services/knowledge-wiki-jobs.service.js');
 for(const body of [undefined,null,[],false])await assert.rejects(()=>admitWikiJob(null,body,'synthetic-idempotency'),e=>e.name==='ZodError');
});
test('local reanalysis remains operational after an explicitly approved cloud result',async()=>{
 const {startEmbeddingFixture}=await import('./vault-semantic-fixture.js');const wire=await startEmbeddingFixture();
 const oldModel=process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL,oldBase=process.env.OLLAMA_BASE_URL;
 process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL='synthetic-local';process.env.OLLAMA_BASE_URL=wire.baseUrl;
 const {vaultSemantic,legacyVaultScope}=await import('../src/services/vault-semantic.service.js');
 const scope=legacyVaultScope({tenantId:'local-return',orgId:'local-return',userId:'local-return'});
 const source={id:'s',title:'S',content:'SYNTH_RELATED',version:1},target={id:'t',title:'T',content:'SYNTH_PARAPHRASE',version:1};
 try {
  vaultSemantic.acceptCloud(scope,{inputs:[source,target].map(n=>({...n,version:String(n.version)})),model:'synthetic-cloud'},[[1,0],[1,0]],{scope_hash:'synthetic'});
  vaultSemantic.schedule(scope,source,()=>[target]);await vaultSemantic.wait(scope,source.id);
  const result=vaultSemantic.graph(scope,[source,target]);assert.equal(result.analysis[0].state,'ready');assert.equal(result.edges.length,1);assert.equal(result.edges[0].provenance.provider,'ollama-local');
 }finally{await wire.close();if(oldModel===undefined)delete process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL;else process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL=oldModel;if(oldBase===undefined)delete process.env.OLLAMA_BASE_URL;else process.env.OLLAMA_BASE_URL=oldBase;}
});
test('unapproved personal consent expires without inference or timers racing',async t=>{
 const {preparePersonalConsent,readPersonalConsent}=await import('../src/services/personal-cloud-consent.service.js');
 t.mock.timers.enable({apis:['Date'],now:1000});
 const context={store:'pg',scope:'personal',actorId:'synthetic-owner'};
 const approval=preparePersonalConsent(context,{kind:'fixture',inputs:[]});
 t.mock.timers.tick(300001);
 assert.throws(()=>readPersonalConsent(context,approval.token),e=>e.code==='CONSENT_EXPIRED');
});
