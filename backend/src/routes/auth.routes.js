import { Router } from "express";

import * as controller from "../controllers/auth.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const authRouter = Router();

authRouter.post("/signup", asyncRoute(controller.signup));
authRouter.post("/login", asyncRoute(controller.login));
authRouter.post("/logout", asyncRoute(controller.logout));
authRouter.post("/sessions/revoke-all", asyncRoute(controller.revokeAll));
authRouter.post("/password", asyncRoute(controller.changePassword));
authRouter.get("/me", asyncRoute(controller.me));
authRouter.get("/invitations", asyncRoute(controller.listMyInvitations));
authRouter.post("/invitations/verify", asyncRoute(controller.verifyInvitation));
authRouter.post("/invitations/accept", asyncRoute(controller.acceptInvitation));
