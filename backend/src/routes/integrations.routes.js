import { Router } from "express";

import * as controller from "../controllers/integrations.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const integrationsRouter = Router();

integrationsRouter.get("/providers", asyncRoute(controller.listProviders));
integrationsRouter.post("/connections", asyncRoute(controller.connect));
integrationsRouter.get("/connections", asyncRoute(controller.listIntegrations));
integrationsRouter.get("/connections/:integrationId/health", asyncRoute(controller.checkHealth));
integrationsRouter.delete("/connections/:integrationId", asyncRoute(controller.disconnect));

integrationsRouter.post("/webhooks", asyncRoute(controller.createEndpoint));
integrationsRouter.get("/webhooks", asyncRoute(controller.listEndpoints));
integrationsRouter.delete("/webhooks/:endpointId", asyncRoute(controller.deleteEndpoint));
integrationsRouter.post("/webhooks/:endpointId/dispatch", asyncRoute(controller.dispatch));
integrationsRouter.get("/webhooks/deliveries", asyncRoute(controller.listDeliveries));
integrationsRouter.post("/webhooks/deliveries/:deliveryId/retry", asyncRoute(controller.retryDelivery));

integrationsRouter.post("/api-keys", asyncRoute(controller.createApiKey));
integrationsRouter.get("/api-keys", asyncRoute(controller.listApiKeys));
integrationsRouter.delete("/api-keys/:keyId", asyncRoute(controller.revokeApiKey));

integrationsRouter.get("/retention", asyncRoute(controller.listRetention));
integrationsRouter.put("/retention", asyncRoute(controller.putRetention));
integrationsRouter.get("/audit", asyncRoute(controller.auditTrail));
integrationsRouter.get("/audit/verify", asyncRoute(controller.verifyAudit));
integrationsRouter.get("/stats", asyncRoute(controller.stats));
