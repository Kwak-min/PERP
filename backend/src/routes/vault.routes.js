import { Router } from "express";

import * as controller from "../controllers/vault.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const vaultRouter = Router();

vaultRouter.post("/notes", asyncRoute(controller.createNote));
vaultRouter.get("/notes", asyncRoute(controller.listNotes));
vaultRouter.get("/graph", asyncRoute(controller.graph));
vaultRouter.get("/notes/:noteId", asyncRoute(controller.getNote));
vaultRouter.patch("/notes/:noteId", asyncRoute(controller.patchNote));
vaultRouter.delete("/notes/:noteId", asyncRoute(controller.deleteNote));
