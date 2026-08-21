import { Router } from "express";

import * as controller from "../controllers/members.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const membersRouter = Router();

membersRouter.get("", asyncRoute(controller.listMembers));
membersRouter.get("/:memberId/profile", asyncRoute(controller.getMemberProfile));
membersRouter.post("/invites", asyncRoute(controller.createInvite));
membersRouter.post("/invites/:invitationId/revoke", asyncRoute(controller.revokeInvite));
membersRouter.post("/provision", asyncRoute(controller.provision));
membersRouter.get("/roles", asyncRoute(controller.listRoles));
membersRouter.get("/departments", asyncRoute(controller.listDepartments));
membersRouter.post("/departments", asyncRoute(controller.createDepartment));
membersRouter.put("/departments/:departmentId/access", asyncRoute(controller.setDepartmentAccess));
membersRouter.patch("/departments/:departmentId", asyncRoute(controller.updateDepartment));
membersRouter.get("/growth", asyncRoute(controller.growth));
membersRouter.get("/activity", asyncRoute(controller.activity));
membersRouter.get("/org-chart", asyncRoute(controller.orgChart));
membersRouter.post("/permissions/simulate", asyncRoute(controller.simulatePermissions));
membersRouter.post("/:membershipId/reset-password", asyncRoute(controller.resetPassword));
membersRouter.patch("/:membershipId/roles", asyncRoute(controller.setRoles));
membersRouter.patch("/:membershipId/assignment", asyncRoute(controller.setAssignment));
membersRouter.patch("/:membershipId/status", asyncRoute(controller.setStatus));
