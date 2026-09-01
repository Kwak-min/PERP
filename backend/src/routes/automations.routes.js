import { Router } from "express";

import * as controller from "../controllers/automations.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const automationsRouter = Router();

automationsRouter.post("/workflows", asyncRoute(controller.createWorkflow));
automationsRouter.get("/workflows", asyncRoute(controller.listWorkflows));
automationsRouter.get("/runs", asyncRoute(controller.listRuns));
automationsRouter.get("/runs/:runId", asyncRoute(controller.getRun));
automationsRouter.get("/workflows/:workflowId", asyncRoute(controller.getWorkflow));
automationsRouter.post("/workflows/:workflowId/versions", asyncRoute(controller.addVersion));
automationsRouter.post("/workflows/:workflowId/publish", asyncRoute(controller.publishWorkflow));
automationsRouter.post("/workflows/:workflowId/disable", asyncRoute(controller.disableWorkflow));
automationsRouter.post("/workflows/:workflowId/run", asyncRoute(controller.runWorkflow));
