import { Router } from "express";
import { z } from "zod";

import { asyncRoute } from "../middleware/error.js";
import { catalog, query } from "../services/agent-capabilities.service.js";
import * as operations from "../services/agent-operation.service.js";
import { requireTurnKey } from "../services/agent-run.service.js";
import { ApiError } from "../utils/errors.js";
import { knowledgeHandlers } from "../controllers/agent-knowledge.controller.js";
import { historyFor, knowledgeProviderTarget } from "../services/agent-chat.service.js";

const querySchema = z.object({ tool: z.string().min(1).max(100), input: z.record(z.unknown()).default({}) }).strict();
const withoutMode = value => {
  const { knowledge_mode: _mode, ...payload } = value ?? {};
  return payload;
};

export function agentOperationsRouter(contextFor) {
  const router = Router();
  const knowledge = knowledgeHandlers(contextFor, { historyFor, providerTarget: knowledgeProviderTarget });
  router.post("/attachments", asyncRoute(knowledge.upload));
  router.get("/attachments/:id", asyncRoute(knowledge.get));
  router.get("/attachments/:id/download", asyncRoute(knowledge.download));
  router.delete("/attachments/:id", asyncRoute(knowledge.remove));
  router.post("/knowledge/consent-preview", asyncRoute(knowledge.previewConsent));
  router.get("/knowledge/notes", asyncRoute(knowledge.listNotes));
  router.get("/knowledge/notes/:id", asyncRoute(knowledge.getNote));
  const route = handler => asyncRoute(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const context = await contextFor(req);
    return handler(context, req, res);
  });
  router.get("/capabilities", route(async (context, _req, res) => res.json({ items: await catalog(context) })));
  router.post("/tools/query", route(async (context, req, res) => {
    const parsed = querySchema.safeParse(withoutMode(req.body));
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "조회 요청 형식이 올바르지 않습니다.");
    res.json(await query(context, parsed.data.tool, parsed.data.input));
  }));
  router.get("/operations", route(async (context, req, res) =>
    res.json({ items: await operations.listOperations(context, withoutMode(req.query)) })));
  router.get("/operations/:id", route(async (context, req, res) =>
    res.json(await operations.getOperation(context, req.params.id))));
  router.get("/operations/:id/approvers", route(async (context, req, res) =>
    res.json({ items: await operations.listOperationApprovers(context, req.params.id) })));
  router.post("/operations", route(async (context, req, res) =>
    res.status(201).json(await operations.propose(context, withoutMode(req.body)))));
  router.post("/operations/:id/confirm", route(async (context, req, res) =>
    res.json(await operations.confirmOperation(context, req.params.id, withoutMode(req.body)))));
  router.post("/operations/:id/execute", route(async (context, req, res) =>
    res.json(await operations.executeOperation(context, req.params.id, withoutMode(req.body), requireTurnKey(req)))));
  router.post("/operations/:id/cancel", route(async (context, req, res) =>
    res.json(await operations.cancelOperation(context, req.params.id, withoutMode(req.body)))));
  return router;
}
