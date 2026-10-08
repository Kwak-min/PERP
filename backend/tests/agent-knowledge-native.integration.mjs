import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import express from 'express';
import { startOrgPostgres } from './pg-org-native-fixture.js';
import { exerciseKnowledgeLane } from './agent-knowledge-scenarios.js';

test('SQLite and native PostgreSQL: scoped knowledge, consent, canonical notes and private upload HTTP', {timeout:180000}, async () => {
  assert.equal(process.env.DEADLINE_ISOLATED,'1');
  const native = await startOrgPostgres();
  let server, closeDb, closePgPool;
  const http = [], outbound = [], queued = [], contexts = new Map();
  try {
    for (const file of ['perp_additions_v9_daily_corrections.sql','perp_additions_v11_deadline_roles.sql','perp_additions_v23_agent_knowledge.sql','perp_additions_v24_workspace_documents.sql']) await native.pool.query(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));
    await native.pool.query(await readFile(new URL('../../db/perp_additions_v23_agent_knowledge.sql',import.meta.url),'utf8'));
    const [{createApp},{migrate},database,pg,{migrateAgentKnowledge},{knowledgeHandlers,knowledgeTransportError},auth,pgAuth,pgAccess,errors,knowledge,provider,{env}] = await Promise.all([
      import('../src/app.js'),import('../src/config/migrate.js'),import('../src/config/db.js'),import('../src/config/pg.js'),import('../src/config/agent-knowledge-migration.js'),
      import('../src/controllers/agent-knowledge.controller.js'),import('../src/middleware/auth.js'),import('../src/middleware/pgAuth.js'),import('../src/middleware/pgAccess.js'),import('../src/middleware/error.js'),
      import('../src/services/agent-knowledge.service.js'),import('../src/services/ai-provider.service.js'),import('../src/config/env.js'),
    ]);
    closeDb=database.closeDb; closePgPool=pg.closePgPool;
    Object.assign(pg.pgPool.options,{host:'127.0.0.1',port:Number(process.env.PG_PORT),database:'postgres',user:'org_test',password:'',connectionTimeoutMillis:5000});
    migrate(); migrateAgentKnowledge(database.db()); migrateAgentKnowledge(database.db());
    const app=express();
    app.use(express.json({limit:'5mb',verify:(req,_res,bytes) => {req.hasJsonBody=bytes.length>0;}}));
    app.use(errors.requestContext); app.use(pgAuth.pgAuthBridge);
    const contextFor = async req => {
      const source=req.path.startsWith('/api/v1/pg/') ? 'pg' : 'legacy';
      const p=source==='pg' ? await pgAccess.resolvePgCompanyPrincipal(req) : auth.resolvePrincipal(req);
      const context={source,request:req,principal:p,actorId:String(p.userId),workspaceId:String(source==='pg' ? p.companyId : p.orgId),knowledgeMode:req.body?.knowledge_mode ?? req.query.knowledge_mode,requestId:req.requestId};
      contexts.set(`${source}:${context.actorId}:${context.knowledgeMode}`,context);
      return context;
    };
    const handlers=knowledgeHandlers(contextFor,{providerTarget:async () => ({provider:'openrouter',model:'knowledge-fixture',external:true})});
    for(const root of ['/api/v1/agent','/api/v1/pg/agent']) {
      app.post(root+'/attachments',handlers.upload);app.get(root+'/attachments/:id',handlers.get);
      app.get(root+'/attachments/:id/download',handlers.download);app.delete(root+'/attachments/:id',handlers.remove);
      app.post(root+'/knowledge/consent-preview',handlers.previewConsent);app.get(root+'/knowledge/notes',handlers.listNotes);app.get(root+'/knowledge/notes/:id',handlers.getNote);
      app.post(root+'/test-prepare',async (req,res) => {const {knowledge_mode,...input}=req.body;res.json(await knowledge.prepareKnowledge(await contextFor(req),input));});
    }
    app.post('/model/chat/completions',(req,res) => {
      assert.equal(req.body.model,'knowledge-fixture');
      outbound.push(req.body);
      const content=queued.shift();
      if (content === undefined) return res.status(500).json({error:'unexpected model dispatch'});
      res.json({model:'knowledge-fixture',choices:[{message:{role:'assistant',content:JSON.stringify(content)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}});
    });
    app.use(createApp());app.use(knowledgeTransportError);app.use(errors.errorHandler);
    server=createServer(app);
    const ready=once(server,'listening',{signal:AbortSignal.timeout(10000)});server.listen(0,'127.0.0.1');await ready;
    const base=`http://127.0.0.1:${server.address().port}`;
    env.openrouterBaseUrl=base+'/model';env.externalModel='knowledge-fixture';provider.REGISTRY.ollama.baseUrl='';
    const adapter=provider.openRouterForKey('synthetic-loopback-key');
    const call=async (actor,route,method='GET',body,expected=200) => {
      const response=await fetch(base+'/api/v1'+route,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${actor.token}`,'X-Org-Id':actor.orgId}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
      const text=await response.text(),value=text?JSON.parse(text):null;
      http.push({method,route,status:response.status,no_store:response.headers.get('cache-control')});
      assert.equal(response.status,expected,`${method} ${route}: ${JSON.stringify(value)}`);return value;
    };
    const makeLegacy=async label => {
      const user=await call(null,'/auth/signup','POST',{name:label,email:randomUUID()+'@example.invalid',password:'password-1234'},201);
      const actor={token:user.access_token,userId:user.user.id,orgId:''};
      const org=await call(actor,'/tenants','POST',{name:label,type:'custom',modules:['agent','documents','projects'],features:[],departments:[]},201);
      actor.orgId=org.org_id;actor.tenantId=org.tenant_id;return actor;
    };
    const legacy=await makeLegacy('Knowledge A'),foreignLegacy=await makeLegacy('Knowledge B');
    const malformed=await fetch(base+'/api/v1/agent/attachments',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${legacy.token}`,'X-Org-Id':legacy.orgId},body:'{"content_base64":"MALFORMED_UPLOAD_SECRET',signal:AbortSignal.timeout(10000)});
    assert.equal(malformed.status,400);assert.equal(malformed.headers.get('cache-control'),'no-store');
    assert.ok(!(await malformed.text()).includes('MALFORMED_UPLOAD_SECRET'));
    const codes=['agent.chat','document.read','document.write','menu.agent','menu.documents','menu.vault'];
    await native.pool.query("INSERT INTO org.permissions(code,module,description) SELECT code,'agent',code FROM unnest($1::text[]) code ON CONFLICT DO NOTHING",[codes]);
    await native.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE p.code=ANY($1::text[]) ON CONFLICT DO NOTHING',[codes]);
    for(const cid of [native.companyId,native.otherCompanyId]) await native.pool.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'agent'),($1,'documents') ON CONFLICT DO NOTHING",[cid]);
    const pgActor=async (user,companyId) => ({token:(await call(null,'/pg/auth/login','POST',{email:user.email,password:'password-1234'})).token,userId:String(user.id),orgId:`pg:${companyId}`});
    const pgA=await pgActor(native.users[0],native.companyId),pgB=await pgActor(native.users[3],native.otherCompanyId);
    await exerciseKnowledgeLane({source:'legacy',actor:legacy,other:foreignLegacy,call,contexts,knowledge,provider,adapter,queued,outbound,database,native});
    await exerciseKnowledgeLane({source:'pg',actor:pgA,other:pgB,call,contexts,knowledge,provider,adapter,queued,outbound,database,native});
    assert.equal(queued.length,0);
  } finally {
    if(server?.listening) await new Promise((resolve,reject) => {server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
    closeDb?.();await closePgPool?.();await native.close();
    const dir=new URL('../../.omo/inapp-agent/',import.meta.url);await mkdir(dir,{recursive:true});
    await writeFile(new URL('knowledge-http-evidence.json',dir),JSON.stringify({http,outbound,cleanup:true},null,2));
  }
});
