import { Router } from "express";

import * as controller from "../controllers/calendar.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const calendarRouter = Router();

calendarRouter.post("", asyncRoute(controller.create));
calendarRouter.get("", asyncRoute(controller.list));
calendarRouter.get("/:eventId", asyncRoute(controller.detail));
calendarRouter.patch("/:eventId", asyncRoute(controller.patch));
calendarRouter.delete("/:eventId", asyncRoute(controller.archive));
calendarRouter.post("/:eventId/attendees", asyncRoute(controller.addEventAttendees));
calendarRouter.post("/:eventId/respond", asyncRoute(controller.respond));
