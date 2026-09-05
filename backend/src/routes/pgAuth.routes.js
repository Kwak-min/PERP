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
pgRouter.get("/members/departments", asyncRoute(members.listDepartments));
pgRouter.get("/members/roles", asyncRoute(members.listRoles));

// 모듈 read 슬라이스 (1단계) — 회사(company_id) 스코프
pgRouter.get("/usage", asyncRoute(mod.usage));
pgRouter.get("/projects", asyncRoute(mod.projects));
pgRouter.post("/projects", asyncRoute(mod.createProject));
pgRouter.get("/projects/options", asyncRoute(mod.projectOptions));
pgRouter.get("/tasks", asyncRoute(mod.tasks));
pgRouter.get("/approvals", asyncRoute(mod.approvals));
pgRouter.get("/documents", asyncRoute(mod.documents));
pgRouter.post("/documents", asyncRoute(mod.createDocument));
pgRouter.get("/calendar", asyncRoute(mod.calendar));
pgRouter.post("/calendar", asyncRoute(mod.createCalendarEvent));
pgRouter.get("/finance/summary", asyncRoute(mod.financeSummary));
pgRouter.get("/finance/accounts", asyncRoute(mod.financeAccounts));
pgRouter.get("/finance/transactions", asyncRoute(mod.financeTransactions));
pgRouter.post("/finance/transactions", asyncRoute(mod.createTransaction));
pgRouter.get("/hr/attendance", asyncRoute(mod.hrAttendance));
pgRouter.get("/hr/leaves", asyncRoute(mod.hrLeaves));
pgRouter.get("/hr/postings", asyncRoute(mod.hrPostings));
