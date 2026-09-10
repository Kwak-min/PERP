import * as money from '../controllers/projectMoney.controller.js';
import { Router } from "express";
import { listLegacyCreateTaskAssignees, listLegacyProjectCandidates, listLegacyProjectMembers } from '../controllers/projectMembers.controller.js';

import * as controller from "../controllers/projects.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const projectsRouter = Router();

projectsRouter.get('/:projectId/money', asyncRoute(money.legacySummary));
projectsRouter.post('/:projectId/money/budgets', asyncRoute(money.legacyCreateBudget));
projectsRouter.post('/:projectId/money/budgets/:budgetId/associate', asyncRoute(money.legacyAssociateBudget));
projectsRouter.post("", asyncRoute(controller.create));
projectsRouter.get("", asyncRoute(controller.list));
projectsRouter.get("/:projectId", asyncRoute(controller.detail));
projectsRouter.patch("/:projectId", asyncRoute(controller.patch));
projectsRouter.delete("/:projectId", asyncRoute(controller.archive));
projectsRouter.post("/:projectId/milestones", asyncRoute(controller.addMilestone));
projectsRouter.get('/:projectId/candidates', asyncRoute(listLegacyProjectCandidates));
projectsRouter.get('/:projectId/task-assignees', asyncRoute(listLegacyCreateTaskAssignees));
projectsRouter.get('/:projectId/members', asyncRoute(listLegacyProjectMembers));
projectsRouter.post("/:projectId/members", asyncRoute(controller.addMember));
