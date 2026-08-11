import { Router } from "express";

import * as controller from "../controllers/approvals.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const approvalsRouter = Router();

approvalsRouter.post("/forms", asyncRoute(controller.createForm));
approvalsRouter.get("/forms", asyncRoute(controller.listForms));
approvalsRouter.post("/requests", asyncRoute(controller.requestApproval));
approvalsRouter.get("/requests", asyncRoute(controller.listRequests));
approvalsRouter.get("/requests/:approvalId", asyncRoute(controller.getRequest));
approvalsRouter.post("/requests/:approvalId/actions", asyncRoute(controller.decide));
approvalsRouter.post("/requests/:approvalId/withdraw", asyncRoute(controller.withdraw));
approvalsRouter.post("/requests/:approvalId/delegate", asyncRoute(controller.delegate));
