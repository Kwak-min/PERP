import { Router } from "express";

import * as controller from "../controllers/imports.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const importsRouter = Router();

importsRouter.get("/templates", asyncRoute(controller.templates));
importsRouter.post("", asyncRoute(controller.createImport));
importsRouter.get("", asyncRoute(controller.listImports));
importsRouter.get("/:jobId", asyncRoute(controller.getImport));
importsRouter.post("/:jobId/commit", asyncRoute(controller.commitImport));
