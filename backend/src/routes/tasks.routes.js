import { Router } from "express";

import * as controller from "../controllers/tasks.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const tasksRouter = Router();

tasksRouter.post("", asyncRoute(controller.create));
tasksRouter.get("", asyncRoute(controller.list));
tasksRouter.get("/board", asyncRoute(controller.board));
tasksRouter.get("/workload/summary", asyncRoute(controller.workload));
tasksRouter.get("/:taskId", asyncRoute(controller.detail));
tasksRouter.patch("/:taskId", asyncRoute(controller.patch));
tasksRouter.post("/:taskId/checklist", asyncRoute(controller.addChecklist));
tasksRouter.post("/:taskId/checklist/:itemId/toggle", asyncRoute(controller.toggleChecklist));
tasksRouter.post("/:taskId/dependencies", asyncRoute(controller.addDependency));
tasksRouter.post("/:taskId/comments", asyncRoute(controller.addComment));
