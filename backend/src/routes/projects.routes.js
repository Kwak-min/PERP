import { Router } from "express";

import * as controller from "../controllers/projects.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const projectsRouter = Router();

projectsRouter.post("", asyncRoute(controller.create));
projectsRouter.get("", asyncRoute(controller.list));
projectsRouter.get("/:projectId", asyncRoute(controller.detail));
projectsRouter.patch("/:projectId", asyncRoute(controller.patch));
projectsRouter.delete("/:projectId", asyncRoute(controller.archive));
projectsRouter.post("/:projectId/milestones", asyncRoute(controller.addMilestone));
projectsRouter.post("/:projectId/members", asyncRoute(controller.addMember));
