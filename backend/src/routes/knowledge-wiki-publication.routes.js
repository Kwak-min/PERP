import {Router} from 'express';
import {asyncRoute} from '../middleware/error.js';
import {resolvePrincipal} from '../middleware/auth.js';
import {pgIdentity,pgRoute} from '../middleware/pgAccess.js';
import {pgAuthBridge} from '../middleware/pgAuth.js';
import {wikiContext,withKnowledgeTransaction} from '../services/knowledge-wiki-store.service.js';
import {wikiError} from '../services/knowledge-wiki-contract.service.js';
import {subscribeWikiChanges,wikiScopeKey} from '../services/knowledge-wiki-signals.service.js';
import {inspectChangeSet,publishChangeSet,rejectChangeSet,createManualChangeSet,pageHistory,wikiGraph,eventProjection,graphProjection} from '../services/knowledge-wiki-publication.service.js';

// Root가 knowledgeWikiRouter의 기존 GET projection보다 먼저 mount한다.
export function knowledgeWikiPublicationRouter(store,scope) {
  const router=Router();
  const context=req=>{
    if(store==='pg'){const identity=pgIdentity(req);return wikiContext({store,scope,actorId:identity.userId,companyId:identity.companyId});}
    const p=resolvePrincipal(req);return wikiContext({store,scope,actorId:p.userId,tenantId:p.tenantId,companyId:p.orgId});
  };
  function route(method,path,write,handler) {
    const execute=async(req,res)=>{
      res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
      return handler(context(req),req,res);
    };
    router[method](path,asyncRoute(store==='pg'?pgRoute(execute,scope==='company'?`document.${write?'write':'read'}`:null,scope==='company'?'documents':null):execute));
  }
  route('get','/change-sets/:id',false,async(ctx,req,res)=>res.json(await inspectChangeSet(ctx,req.params.id)));
  route('post','/change-sets/:id/publish',true,async(ctx,req,res)=>res.json(await publishChangeSet(ctx,req.params.id,req.body,req.get('idempotency-key'))));
  route('post','/change-sets/:id/reject',true,async(ctx,req,res)=>res.json(await rejectChangeSet(ctx,req.params.id,req.body)));
  route('post','/pages/:id/change-sets',true,async(ctx,req,res)=>res.status(201).json(await createManualChangeSet(ctx,req.params.id,req.body)));
  route('get','/pages/:id/history',false,async(ctx,req,res)=>res.json(await pageHistory(ctx,req.params.id)));
  route('get','/pages/:id/backlinks',false,async(ctx,req,res)=>{
    const graph=await wikiGraph(ctx),node=graph.nodes.find(n=>n.page_id===req.params.id);
    if(!node) throw wikiError('NOT_FOUND',404);
    res.json({items:graph.edges.filter(edge=>edge.target===node.id || (edge.direction==='undirected' && edge.source===node.id))});
  });
  route('get','/pages/:id',false,async(ctx,req,res)=>{
    const result=await withKnowledgeTransaction(ctx,{},function*(tx){
      const page=yield* tx.get('page',req.params.id);
      const revision=page && (yield* tx.pageRevision(req.query.revision ?? page.published_head_id,{current:!req.query.revision}));
      if(!revision || revision.page_id!==req.params.id) throw wikiError('NOT_FOUND',404);
      return revision;
    });res.json(result);
  });
  route('get','/pages',false,async(ctx,_req,res)=>res.json(await withKnowledgeTransaction(ctx,{},function*(tx){return {items:(yield* tx.pages()).map(p=>({id:p.page_id,revision_id:p.id,title:p.title,kind:p.kind,version:p.version,freshness:p.freshness})),next_cursor:null};})));
  route('get','/graph',false,async(ctx,_req,res)=>res.json(await wikiGraph(ctx)));
  route('get','/index.md',false,async(ctx,_req,res)=>res.type('text/markdown').send(await withKnowledgeTransaction(ctx,{},function*(tx){return (yield* tx.pages()).map(p=>p.index_entry).join('\n');})));
  route('get','/log.md',false,async(ctx,_req,res)=>res.type('text/markdown').send(await withKnowledgeTransaction(ctx,{},function*(tx){return (yield* eventProjection(tx)).items.map(e=>`- ${e.sequence} ${e.created_at} ${e.kind}`).join('\n');})));
  // URL token은 신원 경계 진입 전에도 거절한다.
  router.get('/events',(req,_res,next)=>{
    if(Object.keys(req.query).some(k=>k!=='cursor')) return next(wikiError('VALIDATION_ERROR',400));
    next();
  });
  route('get','/events',false,async(ctx,req,res)=>{
    const raw=req.get('last-event-id') ?? req.query.cursor ?? '0';
    if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))) throw wikiError('VALIDATION_ERROR',400);
    let cursor=Number(raw),closed=false,dirty=false,running=false,ready=false,expiry,stopSignals,setupError;
    async function freshContext(){
      const fresh={get:req.get.bind(req),method:req.method,path:req.path,baseUrl:req.baseUrl,originalUrl:req.originalUrl};
      if(store==='pg') {
        await new Promise((resolve,reject)=>pgAuthBridge(fresh,res,error=>error?reject(error):resolve()));
        await pgRoute(()=>{},scope==='company'?'document.read':null,scope==='company'?'documents':null)(fresh,res);
      }
      return context(fresh);
    }
    const close=()=>{if(closed)return;closed=true;clearTimeout(expiry);stopSignals?.();};
    const send=(event,data,id)=>{
      if(closed)return;
      if(!res.write(`${id===undefined?'':`id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {close();res.end();}
    };
    async function drain(initial=false){
      running=true;
      try {
        do {
          dirty=false;
          const current=await freshContext();
          const state=await withKnowledgeTransaction(current,{},function*(tx){return {events:yield* eventProjection(tx,cursor),graph:yield* graphProjection(tx)};});
          if(closed)return;
          if(initial){res.status(200).set({'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();initial=false;}
          send('state',{counts:state.graph.counts,cursor});
          for(const event of state.events.items){send('wiki',event,event.sequence);cursor=event.sequence;}
        }while(dirty&&!closed);
      }finally{running=false;}
    }
    function streamError(error){
      if(!res.headersSent){setupError=error;return;}
      send('unavailable',{code:[401,403,404].includes(error.status)?'SOURCE_REVOKED':'SERVICE_UNAVAILABLE'});close();res.end();
    }
    function wake(signal){
      if(closed||signal?.scope_key!==wikiScopeKey(ctx))return;
      dirty=true;
      if(ready&&!running) void drain().catch(streamError);
    }
    res.once('close',close);
    try{
      stopSignals=await subscribeWikiChanges(ctx,wake,streamError);
      if(closed){stopSignals();return;}
      if(setupError)throw setupError;
      ready=true;
      await drain(true);
      if(setupError)streamError(setupError);
    }catch(error){close();throw error;}
    // 최대 연결 수명. 재접속은 마지막 인가 cursor로 재검사하며 서버 polling은 없다.
    if(!closed){expiry=setTimeout(()=>{close();res.end();},60000);expiry.unref();}
  });
  return router;
}
