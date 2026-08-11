import { Router } from "express";

import * as controller from "../controllers/agent.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const agentRouter = Router();

agentRouter.post("/chat", asyncRoute(controller.chat));
agentRouter.get("/conversations", asyncRoute(controller.listConversations));
agentRouter.get("/brief", asyncRoute(controller.brief));

agentRouter.get("/memory", asyncRoute(controller.listMemory));
agentRouter.post("/memory", asyncRoute(controller.createMemory));
agentRouter.delete("/memory", asyncRoute(controller.clearMemory));
agentRouter.patch("/memory/:memoryId", asyncRoute(controller.updateMemory));
agentRouter.delete("/memory/:memoryId", asyncRoute(controller.deleteMemory));

agentRouter.get("/tools", asyncRoute(controller.listTools));
agentRouter.get("/actions", asyncRoute(controller.listActions));
agentRouter.post("/actions", asyncRoute(controller.previewAction));
agentRouter.post("/actions/:actionId/execute", asyncRoute(controller.executeAction));
agentRouter.post("/actions/:actionId/rollback", asyncRoute(controller.rollbackAction));

agentRouter.get("/profile", asyncRoute(controller.getProfile));
agentRouter.put("/profile", asyncRoute(controller.putProfile));
agentRouter.get("/providers", asyncRoute(controller.listProviders));
agentRouter.get("/usage", asyncRoute(controller.usage));
