import { Router } from 'express';
import { asyncRoute } from '../middleware/error.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { pgIdentity, pgRoute } from '../middleware/pgAccess.js';
import { wikiContext, withKnowledgeTransaction, TRUSTED_SCHEMA } from '../services/knowledge-wiki-store.service.js';
import { sourceRegistrationSchema, recaptureSchema, sourceCasSchema, wikiError } from '../services/knowledge-wiki-contract.service.js';

import { knowledgeWikiJobsRouter } from './knowledge-wiki-jobs.routes.js';

// 원본 projection과 private 작업 router. 게시 capability는 별도 소유자다.
export function knowledgeWikiRouter(store, scope) {
  const router = Router();
  const context = req => {
    if (store === 'pg') { const identity = pgIdentity(req); return wikiContext({store,scope,actorId:identity.userId,companyId:identity.companyId}); }
    const p = resolvePrincipal(req); return wikiContext({store,scope,actorId:p.userId,tenantId:p.tenantId,companyId:p.orgId});
  };
  router.use('/jobs',knowledgeWikiJobsRouter(store,scope,context));
  function route(method,path,write,handler) {
    const execute = async (req,res) => {
      res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
      const result = await withKnowledgeTransaction(context(req),{write},function*(tx) { return yield* handler(tx,req); });
      if (result.type) res.type(result.type);
      res.status(result.status ?? 200).send(result.body);
    };
    router[method](path,asyncRoute(store === 'pg' ? pgRoute(execute,scope === 'company' ? `document.${write ? 'write' : 'read'}` : null,scope === 'company' ? 'documents' : null) : execute));
  }
  route('get','/',false,function*(tx) { return {body:{wiki:tx.wiki,pages:(yield* tx.pages()).map(p => ({id:p.page_id,revision_id:p.id,title:p.title,kind:p.kind,version:p.version}))}}; });
  route('post','/sources',true,function*(tx,req) {
    const result = yield* tx.register(sourceRegistrationSchema.parse(req.body));
    return {status:result.created ? 201 : 200,body:result};
  });
  route('get','/sources',false,function*(tx,req) { return {body:yield* tx.sources({cursor:req.query.cursor ?? '',limit:req.query.limit === undefined ? 50 : Number(req.query.limit)})}; });
  route('post','/sources/:id/revisions',true,function*(tx,req) { return {status:201,body:yield* tx.recapture(req.params.id,recaptureSchema.parse(req.body))}; });
  route('get','/sources/:id/revisions/:revisionId',false,function*(tx,req) {
    const revision = yield* tx.sourceRevision(req.params.revisionId);
    if (!revision || revision.source_id !== req.params.id) throw wikiError('NOT_FOUND',404);
    return {body:revision};
  });
  route('delete','/sources/:id',true,function*(tx,req) { return {body:yield* tx.withdraw(req.params.id,sourceCasSchema.parse(req.body).expected_version)}; });
  route('get','/pages',false,function*(tx) { return {body:{items:(yield* tx.pages()).map(p => ({id:p.page_id,revision_id:p.id,title:p.title,kind:p.kind,version:p.version,freshness:p.freshness})),next_cursor:null}}; });
  route('get','/pages/:id',false,function*(tx,req) {
    const page = yield* tx.get('page',req.params.id);
    const revision = page && (yield* tx.pageRevision(req.query.revision ?? page.published_head_id,{current:!req.query.revision}));
    if (!revision || revision.page_id !== req.params.id) throw wikiError('NOT_FOUND',404);
    return {body:revision};
  });
  route('get','/index.md',false,function*(tx) { return {type:'text/markdown',body:(yield* tx.pages()).map(p => p.index_entry).join('\n')}; });
  route('get','/schema.md',false,function*(tx) {
    const schema = tx.wiki && (yield* tx.get('schema_revision',tx.wiki.active_schema_id));
    return {type:'text/markdown',body:schema?.rules_md ?? TRUSTED_SCHEMA.rules_md};
  });
  route('get','/log.md',false,function*(tx) {
    const lines = [];
    for (const event of yield* tx.all('event',{orderBy:['sequence']})) {
      if (event.source_revision_id && !(yield* tx.sourceRevision(event.source_revision_id))) continue;
      if (event.page_revision_id && !(yield* tx.pageRevision(event.page_revision_id))) continue;
      if (event.job_id || event.change_set_id) continue; // private job/draft log은 후속 worker의 fresh predicate가 소유한다.
      lines.push(`- ${event.sequence} ${event.created_at} ${event.kind}`);
    }
    return {type:'text/markdown',body:lines.join('\n')};
  });
  return router;
}
