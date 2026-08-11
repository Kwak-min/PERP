import { Router } from "express";

import * as controller from "../controllers/hr.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const hrRouter = Router();

hrRouter.post("/attendance", asyncRoute(controller.checkAttendance));
hrRouter.get("/attendance", asyncRoute(controller.listAttendance));

hrRouter.post("/leaves", asyncRoute(controller.requestLeave));
hrRouter.get("/leaves", asyncRoute(controller.listLeaves));
hrRouter.post("/leaves/:leaveId/decide", asyncRoute(controller.decideLeave));

hrRouter.get("/leave-balances", asyncRoute(controller.listBalances));
hrRouter.post("/leave-balances", asyncRoute(controller.grantBalance));

hrRouter.post("/postings", asyncRoute(controller.createPosting));
hrRouter.get("/postings", asyncRoute(controller.listPostings));
hrRouter.post("/postings/:postingId/close", asyncRoute(controller.closePosting));
hrRouter.post("/postings/:postingId/applications", asyncRoute(controller.apply));
hrRouter.get("/postings/:postingId/applications", asyncRoute(controller.listApplications));
hrRouter.get("/applications", asyncRoute(controller.listApplications));
hrRouter.post("/applications/:applicationId/stage", asyncRoute(controller.moveStage));

hrRouter.post("/onboarding", asyncRoute(controller.createOnboarding));
hrRouter.get("/onboarding", asyncRoute(controller.listOnboarding));
hrRouter.post("/onboarding/:itemId/complete", asyncRoute(controller.completeOnboardingItem));
