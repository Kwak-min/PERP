import { Router } from "express";

import * as controller from "../controllers/documents.controller.js";
import { asyncRoute } from "../middleware/error.js";

import { knowledgeWikiRouter } from './knowledge-wiki.routes.js';
import { knowledgeWikiPublicationRouter } from './knowledge-wiki-publication.routes.js';

export const documentsRouter = Router();
documentsRouter.use('/wiki', knowledgeWikiPublicationRouter('legacy', 'company'));
documentsRouter.use('/wiki', knowledgeWikiRouter('legacy', 'company'));

documentsRouter.post("/spaces", asyncRoute(controller.createSpace));
documentsRouter.get("/spaces", asyncRoute(controller.listSpaces));
documentsRouter.get("/search/query", asyncRoute(controller.searchDocuments));
documentsRouter.post("/upload", asyncRoute(controller.uploadDocument));
// 주의: 정적·analysis 경로는 "/:documentId" 보다 먼저 등록해야 한다.
documentsRouter.get("/graph", asyncRoute(controller.graph));
documentsRouter.post("/meetings", asyncRoute(controller.createMeeting));
documentsRouter.get("/meetings/:meetingId", asyncRoute(controller.getMeeting));
documentsRouter.post("/meetings/:meetingId/decisions", asyncRoute(controller.addDecision));
documentsRouter.post("/meetings/:meetingId/decisions/confirm", asyncRoute(controller.confirmDecisions));
documentsRouter.post("", asyncRoute(controller.createDocument));
documentsRouter.get("", asyncRoute(controller.listDocuments));
documentsRouter.get("/:documentId/analysis", asyncRoute(controller.documentAnalysis));
documentsRouter.post("/:documentId/analysis", asyncRoute(controller.documentAnalysis));
documentsRouter.get("/:documentId", asyncRoute(controller.getDocument));
documentsRouter.patch("/:documentId", asyncRoute(controller.patchDocument));
documentsRouter.delete("/:documentId", asyncRoute(controller.archiveDocument));
documentsRouter.post("/:documentId/restore/:revision", asyncRoute(controller.restoreVersion));
