import { Router } from "express";

import * as controller from "../controllers/agent.controller.js";
import * as keyController from "../controllers/agent-key.controller.js";
import { asyncRoute } from "../middleware/error.js";
import { agentOperationsRouter } from "./agent-operations.routes.js";

export const agentRouter = Router();
agentRouter.use(agentOperationsRouter(controller.operationContext));

agentRouter.post("/chat", asyncRoute(controller.chat));
agentRouter.get("/conversations", asyncRoute(controller.listConversations));
agentRouter.get("/brief", asyncRoute(controller.brief));
agentRouter.get("/pending-approvals", asyncRoute(controller.pendingApprovals));

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

agentRouter.get("/api-key", asyncRoute(keyController.getKey));
agentRouter.put("/api-key", asyncRoute(keyController.putKey));
agentRouter.delete("/api-key", asyncRoute(keyController.deleteKey));
agentRouter.post("/api-key/test", asyncRoute(keyController.testKey));

agentRouter.get("/profile", asyncRoute(controller.getProfile));
agentRouter.put("/profile", asyncRoute(controller.putProfile));
agentRouter.get("/providers", asyncRoute(controller.listProviders));
agentRouter.get("/usage", asyncRoute(controller.usage));
