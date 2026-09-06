import { Router } from "express";

import * as controller from "../controllers/pgAuth.controller.js";
import * as members from "../controllers/pgMembers.controller.js";
import * as mod from "../controllers/pgModules.controller.js";
import { asyncRoute } from "../middleware/error.js";

// perp_db (PostgreSQL) 슬라이스 라우터. strangler-fig: 기존 SQLite 라우트와 분리.
// 마운트 지점: /api/v1/pg
export const pgRouter = Router();

pgRouter.get("/health", asyncRoute(controller.health));
pgRouter.post("/auth/signup", asyncRoute(controller.signup));
pgRouter.post("/auth/login", asyncRoute(controller.login));
pgRouter.get("/auth/me", asyncRoute(controller.me));
pgRouter.post("/auth/logout", asyncRoute(controller.logout));

// 구성원(members) 슬라이스 — 회사(company_id) 스코프
pgRouter.get("/members", asyncRoute(members.listMembers));
pgRouter.post("/members", asyncRoute(mod.createMember));
pgRouter.get("/members/departments", asyncRoute(members.listDepartments));
pgRouter.post("/members/departments", asyncRoute(members.createDepartment));
pgRouter.patch("/members/departments/:id", asyncRoute(members.updateDepartment));
pgRouter.get("/members/roles", asyncRoute(members.listRoles));
pgRouter.get("/members/org-chart", asyncRoute(members.orgChart));
pgRouter.get("/members/activity", asyncRoute(mod.membersActivity));
pgRouter.put("/members/departments/:id/access", asyncRoute(mod.departmentAccess));
pgRouter.patch("/members/:membershipId/assignment", asyncRoute(members.assignMember));
pgRouter.get("/vault/notes", asyncRoute(mod.vaultNotes));
pgRouter.get("/vault/notes/:id", asyncRoute(mod.vaultNote));
pgRouter.post("/vault/notes", asyncRoute(mod.vaultCreateNote));
pgRouter.patch("/vault/notes/:id", asyncRoute(mod.vaultUpdateNote));
pgRouter.delete("/vault/notes/:id", asyncRoute(mod.vaultDeleteNote));
pgRouter.get("/departments/options", asyncRoute(mod.departmentOptions));
pgRouter.get("/positions/options", asyncRoute(mod.positionOptions));
pgRouter.get("/org/modules", asyncRoute(mod.getOrgModules));
pgRouter.patch("/org/modules", asyncRoute(mod.updateOrgModules));

// 모듈 read 슬라이스 (1단계) — 회사(company_id) 스코프
pgRouter.get("/usage", asyncRoute(mod.usage));
pgRouter.get("/projects", asyncRoute(mod.projects));
pgRouter.post("/projects", asyncRoute(mod.createProject));
pgRouter.get("/projects/options", asyncRoute(mod.projectOptions));
pgRouter.get("/tasks", asyncRoute(mod.tasks));
pgRouter.post("/tasks", asyncRoute(mod.createTask));
pgRouter.get("/approvals", asyncRoute(mod.approvals));
pgRouter.post("/approvals", asyncRoute(mod.createApproval));
pgRouter.get("/documents", asyncRoute(mod.documents));
pgRouter.post("/documents", asyncRoute(mod.createDocument));
pgRouter.get("/calendar", asyncRoute(mod.calendar));
pgRouter.post("/calendar", asyncRoute(mod.createCalendarEvent));
pgRouter.get("/finance/summary", asyncRoute(mod.financeSummary));
pgRouter.get("/finance/accounts", asyncRoute(mod.financeAccounts));
pgRouter.get("/finance/transactions", asyncRoute(mod.financeTransactions));
pgRouter.post("/finance/transactions", asyncRoute(mod.createTransaction));
pgRouter.get("/finance/budgets", asyncRoute(mod.budgets));
pgRouter.post("/finance/budgets", asyncRoute(mod.createBudget));
pgRouter.get("/finance/dues", asyncRoute(mod.dues));
pgRouter.post("/finance/dues", asyncRoute(mod.createDuesCharge));
pgRouter.get("/finance/settlements", asyncRoute(mod.settlements));
pgRouter.post("/finance/settlements", asyncRoute(mod.createSettlement));
pgRouter.get("/members/options", asyncRoute(mod.memberOptions));
pgRouter.get("/assets", asyncRoute(mod.assets));
pgRouter.post("/assets", asyncRoute(mod.createAsset));
pgRouter.get("/assets/reservations", asyncRoute(mod.assetReservations));
pgRouter.get("/notifications", asyncRoute(mod.notifications));
pgRouter.get("/agent/templates", asyncRoute(mod.agentTemplates));
pgRouter.post("/agent/templates", asyncRoute(mod.createAgentTemplate));
pgRouter.get("/agent/memory", asyncRoute(mod.agentMemory));
pgRouter.post("/agent/memory", asyncRoute(mod.createAgentMemory));
pgRouter.get("/automation/runs", asyncRoute(mod.automationRuns));
pgRouter.get("/records/:resource/:id", asyncRoute(mod.getRecord));
pgRouter.patch("/records/:resource/:id", asyncRoute(mod.updateRecord));
pgRouter.delete("/records/:resource/:id", asyncRoute(mod.deleteRecord));
pgRouter.get("/hr/attendance", asyncRoute(mod.hrAttendance));
pgRouter.post("/hr/attendance/check-in", asyncRoute(mod.hrCheckIn));
pgRouter.post("/hr/attendance/check-out", asyncRoute(mod.hrCheckOut));
pgRouter.get("/hr/attendance/corrections", asyncRoute(mod.hrCorrections));
pgRouter.get("/hr/attendance/corrections/pending", asyncRoute(mod.hrCorrections));
pgRouter.post("/hr/attendance/corrections", asyncRoute(mod.hrCorrectionSubmit));
pgRouter.post("/hr/attendance/corrections/:id/decide", asyncRoute(mod.hrCorrectionDecide));
pgRouter.get("/hr/leaves", asyncRoute(mod.hrLeaves));
pgRouter.post("/hr/leaves", asyncRoute(mod.hrLeaveApply));
pgRouter.get("/hr/leaves/calendar", asyncRoute(mod.hrLeaveCalendar));
pgRouter.post("/hr/leaves/:id/decide", asyncRoute(mod.hrLeaveDecide));
pgRouter.get("/hr/leave-balances", asyncRoute(mod.hrLeaveBalances));
pgRouter.get("/hr/leave-policies", asyncRoute(mod.hrLeavePolicies));
pgRouter.get("/hr/leave-stats", asyncRoute(mod.hrLeaveStats));
pgRouter.get("/hr/postings", asyncRoute(mod.hrPostings));
pgRouter.post("/hr/postings/:id/close", asyncRoute(mod.hrPostingClose));
pgRouter.get("/hr/postings/:id/applications", asyncRoute(mod.hrPostingApplications));
pgRouter.post("/hr/applications/:id/stage", asyncRoute(mod.hrApplicationStage));
pgRouter.get("/hr/onboarding", asyncRoute(mod.hrOnboarding));
pgRouter.post("/hr/onboarding/:id/complete", asyncRoute(mod.hrOnboardingComplete));
pgRouter.post("/members/invites", asyncRoute(mod.membersInvite));
