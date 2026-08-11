import { Router } from "express";

import * as controller from "../controllers/tenants.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const tenantsRouter = Router();

tenantsRouter.get("/templates", asyncRoute(controller.templates));
tenantsRouter.get("/modules/catalog", asyncRoute(controller.publicModuleCatalog));
tenantsRouter.get("/modules", asyncRoute(controller.moduleCatalog));
tenantsRouter.post("", asyncRoute(controller.createOrg));
tenantsRouter.get("/current", asyncRoute(controller.current));
tenantsRouter.patch("/current", asyncRoute(controller.updateOrg));
tenantsRouter.get("/usage", asyncRoute(controller.usage));
