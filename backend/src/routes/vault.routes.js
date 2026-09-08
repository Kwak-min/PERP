import { Router } from "express";

import * as controller from "../controllers/vault.controller.js";
import { asyncRoute } from "../middleware/error.js";

import { knowledgeWikiRouter } from './knowledge-wiki.routes.js';
import { knowledgeWikiPublicationRouter } from './knowledge-wiki-publication.routes.js';

export const vaultRouter = Router();
vaultRouter.use('/wiki', knowledgeWikiPublicationRouter('legacy', 'personal'));
vaultRouter.use('/wiki', knowledgeWikiRouter('legacy', 'personal'));

vaultRouter.post("/notes", asyncRoute(controller.createNote));
vaultRouter.get("/notes", asyncRoute(controller.listNotes));
vaultRouter.get("/graph", asyncRoute(controller.graph));
vaultRouter.get("/notes/:noteId", asyncRoute(controller.getNote));
vaultRouter.get("/notes/:noteId/analysis", asyncRoute(controller.noteAnalysis));
vaultRouter.post("/notes/:noteId/analysis", asyncRoute(controller.noteAnalysis));
vaultRouter.patch("/notes/:noteId", asyncRoute(controller.patchNote));
vaultRouter.delete("/notes/:noteId", asyncRoute(controller.deleteNote));
