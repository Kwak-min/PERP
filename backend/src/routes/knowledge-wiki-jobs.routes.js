import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/error.js';
import { pgRoute } from '../middleware/pgAccess.js';
import { admitWikiJob, getWikiJob, retryWikiJob, cancelWikiJob, draftWikiQuery } from '../services/knowledge-wiki-jobs.service.js';
import { configuredWikiModel } from '../services/knowledge-wiki-worker.service.js';

export function knowledgeWikiJobsRouter(store,scope,context) {
  const router=Router(),empty=z.object({}).strict();
  function route(method,path,write,handler) {
    const execute=async(req,res)=>{
      res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
      await handler(req,res,context(req));
    };
    router[method](path,asyncRoute(store==='pg' ? pgRoute(execute,scope==='company' ? `document.${write ? 'write' : 'read'}` : null,scope==='company' ? 'documents' : null) : execute));
  }
  // Admission/retry/cancel derive mutation authority from the validated or stored
  // operation inside the trusted job transaction. Only draft is always a write.
  route('post','/',false,async(req,res,ctx)=>{
    const admitted=await admitWikiJob(ctx,req.body,req.get('Idempotency-Key'),configuredWikiModel());
    res.status(admitted.created ? 202 : 200).json(admitted.job);
    process.emit('orbitflow:wiki-job-queued');
  });
  route('get','/:id',false,async(req,res,ctx)=>res.json(await getWikiJob(ctx,req.params.id)));
  route('post','/:id/retry',false,async(req,res,ctx)=>{empty.parse(req.body);res.json(await retryWikiJob(ctx,req.params.id));process.emit('orbitflow:wiki-job-queued');});
  route('post','/:id/cancel',false,async(req,res,ctx)=>{empty.parse(req.body);res.json(await cancelWikiJob(ctx,req.params.id));});
  route('post','/:id/draft',true,async(req,res,ctx)=>{empty.parse(req.body);res.json(await draftWikiQuery(ctx,req.params.id));});
  return router;
}
