import { Router } from "express";

import * as controller from "../controllers/hr.controller.js";
import { asyncRoute } from "../middleware/error.js";
import { requireFeature } from "../middleware/features.js";
import { requireModule } from "../middleware/modules.js";

export const hrRouter = Router();

hrRouter.use("/attendance", requireFeature("attendance"));
hrRouter.use(["/leaves", "/leave-balances", "/leave-policies", "/leave-stats"], requireFeature("leave"));
hrRouter.use(["/postings", "/applications", "/onboarding"], requireModule("hr"));

hrRouter.post("/attendance", asyncRoute(controller.checkAttendance));
hrRouter.get("/attendance", asyncRoute(controller.listAttendance));
hrRouter.post("/attendance/check-in", asyncRoute(controller.checkIn));
hrRouter.post("/attendance/check-out", asyncRoute(controller.checkOut));
hrRouter.post("/attendance/corrections", asyncRoute(controller.createAttendanceCorrection));
hrRouter.get("/attendance/corrections", asyncRoute(controller.listMyAttendanceCorrections));
hrRouter.get("/attendance/corrections/pending", asyncRoute(controller.listPendingAttendanceCorrections));
hrRouter.post("/attendance/corrections/:correctionId/decide", asyncRoute(controller.decideAttendanceCorrection));

hrRouter.post("/leaves", asyncRoute(controller.requestLeave));
hrRouter.get("/leaves/calendar", asyncRoute(controller.leaveCalendar));
hrRouter.get("/leaves", asyncRoute(controller.listLeaves));
hrRouter.post("/leaves/:leaveId/decide", asyncRoute(controller.decideLeave));

hrRouter.get("/leave-balances", asyncRoute(controller.listBalances));
hrRouter.post("/leave-balances", asyncRoute(controller.grantBalance));

hrRouter.get("/leave-policies", asyncRoute(controller.listLeavePolicies));
hrRouter.post("/leave-policies", asyncRoute(controller.upsertLeavePolicy));
hrRouter.get("/leave-stats", asyncRoute(controller.leaveStats));

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
