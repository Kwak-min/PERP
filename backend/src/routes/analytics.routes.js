import { Router } from "express";

import * as controller from "../controllers/analytics.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const analyticsRouter = Router();

analyticsRouter.get("/kpis", asyncRoute(controller.kpis));
analyticsRouter.get("/dashboard", asyncRoute(controller.dashboard));
analyticsRouter.get("/reports/:reportKey", asyncRoute(controller.report));

analyticsRouter.post("/exports", asyncRoute(controller.createExport));
analyticsRouter.get("/exports", asyncRoute(controller.listExports));
analyticsRouter.get("/exports/:exportId/download", asyncRoute(controller.downloadExport));
