import {Router} from 'express';
import {z} from 'zod';
import {asyncRoute} from '../middleware/error.js';
import {resolvePrincipal} from '../middleware/auth.js';
import {pgIdentity,pgRoute} from '../middleware/pgAccess.js';
import {wikiContext,withKnowledgeTransaction} from '../services/knowledge-wiki-store.service.js';
import {previewPersonalGraph,analyzePersonalGraph} from '../services/personal-graph-cloud.service.js';
import {cloudApprovalSchema,revokePersonalConsent} from '../services/personal-cloud-consent.service.js';
export function personalCloudRouter(store) {
 const router=Router();
 const scoped=handler=>asyncRoute(store==='pg'?pgRoute(handler):handler);
 const context=req=>{const p=store==='pg'?pgIdentity(req):resolvePrincipal(req);return wikiContext({store,scope:'personal',actorId:p.userId,tenantId:p.tenantId,companyId:p.companyId??p.orgId});};
 router.post('/notes/:noteId/cloud-preview',scoped(async(req,res)=>{z.object({}).strict().parse(req.body);res.set('Cache-Control','private, no-store');res.json(await previewPersonalGraph(context(req),req.params.noteId));}));
 router.delete('/notes/:noteId/cloud-preview',scoped(async(req,res)=>{const c=context(req);await withKnowledgeTransaction(c,{},function*(){});res.json(revokePersonalConsent(c,req.body));}));
 router.post('/notes/:noteId/cloud-analyze',scoped(async(req,res)=>{const approval=cloudApprovalSchema.parse(req.body);res.set('Cache-Control','private, no-store');res.json(await analyzePersonalGraph(context(req),req.params.noteId,approval));}));
 return router;
}
