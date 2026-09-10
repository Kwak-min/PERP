import { z } from 'zod';
import * as attachments from '../services/agent-attachments.service.js';
import { prepareKnowledge, prepareKnowledgeSchema } from '../services/agent-knowledge-prepare.service.js';
import { previewKnowledgeConsent } from '../services/agent-knowledge-consent.service.js';
import { knowledgeMode, failKnowledge } from '../services/agent-knowledge-policy.service.js';
import { listAgentKnowledgeNotes, getAgentKnowledgeNote } from '../services/agent-knowledge-read.service.js';

const previewSchema = prepareKnowledgeSchema.extend({knowledge_mode:z.enum(['personal','company']),conversation_id:z.string().max(100).nullable().optional()}).strict();
export function knowledgeTransportError(error,req,res,next) {
  if (!/^\/api\/v1\/(?:pg\/)?agent\/(?:attachments|knowledge)(?:\/|$)/.test(req.path) || !['entity.parse.failed','entity.too.large'].includes(error?.type)) return next(error);
  res.set('Cache-Control','no-store').status(error.type==='entity.too.large'?413:400).json({error:{code:'VALIDATION_ERROR',message:'Invalid knowledge request body',details:{},request_id:req.requestId ?? ''}});
}

export function knowledgeHandlers(contextFor,{historyFor,providerTarget} = {}) {
  async function context(req,res) {
    res.set('Cache-Control','no-store'); res.set('X-Content-Type-Options','nosniff');
    const mode = knowledgeMode(req.method === 'POST' ? req.body?.knowledge_mode : req.query.knowledge_mode);
    const c = await contextFor(req);
    if (c.knowledgeMode !== mode) failKnowledge('KNOWLEDGE_MODE_MISMATCH',409);
    return c;
  }
  return {
    async listNotes(req,res) {res.json(await listAgentKnowledgeNotes(await context(req,res)));},
    async getNote(req,res) {res.json(await getAgentKnowledgeNote(await context(req,res),req.params.id));},
    async upload(req,res) {
      const c = await context(req,res), {knowledge_mode,...input} = req.body;
      res.status(201).json(await attachments.createAttachment(c,input));
    },
    async get(req,res) {res.json(await attachments.getAttachment(await context(req,res),req.params.id));},
    async remove(req,res) {res.json(await attachments.deleteAttachment(await context(req,res),req.params.id));},
    async download(req,res) {
      const file = await attachments.downloadAttachment(await context(req,res),req.params.id);
      if (req.query.encoding === 'base64') return res.json({filename:file.filename,mime:file.mime,content_base64:file.bytes.toString('base64')});
      res.set('Content-Type','application/octet-stream');
      res.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      res.send(file.bytes);
    },
    async previewConsent(req,res) {
      const c = await context(req,res), parsed = previewSchema.safeParse(req.body);
      if (!parsed.success) failKnowledge('VALIDATION_ERROR');
      const {knowledge_mode,conversation_id,...request} = parsed.data;
      if (!providerTarget || conversation_id && !historyFor) failKnowledge('KNOWLEDGE_INTEGRATION_REQUIRED',503);
      const history = conversation_id ? await historyFor(c,conversation_id) : [];
      const prepared = await prepareKnowledge(c,request), target = await providerTarget(c,prepared,history);
      if (!target.external) failKnowledge('EXTERNAL_CONSENT_NOT_NEEDED',409);
      res.json(await previewKnowledgeConsent(c,{...request,conversation_id,history,provider:target.provider,model:target.model}));
    },
  };
}
