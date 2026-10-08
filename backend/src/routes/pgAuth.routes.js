import { Router } from "express";

import * as controller from "../controllers/pgAuth.controller.js";
import { asyncRoute } from "../middleware/error.js";

// perp_db (PostgreSQL) 슬라이스 라우터. strangler-fig: 기존 SQLite 라우트와 분리.
// 마운트 지점: /api/v1/pg
export const pgRouter = Router();

pgRouter.get("/health", asyncRoute(controller.health));
pgRouter.post("/auth/login", asyncRoute(controller.login));
pgRouter.get("/auth/me", asyncRoute(controller.me));
pgRouter.post("/auth/logout", asyncRoute(controller.logout));
