import { Router } from "express";
import { cancelCalendarEvent } from '../controllers/dailyCorrections.controller.js';

import * as controller from "../controllers/calendar.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const calendarRouter = Router();

calendarRouter.post("", asyncRoute(controller.create));
calendarRouter.get("", asyncRoute(controller.list));
calendarRouter.get("/:eventId", asyncRoute(controller.detail));
calendarRouter.patch("/:eventId", asyncRoute(controller.patch));
calendarRouter.post('/:eventId/cancel', asyncRoute(cancelCalendarEvent));
calendarRouter.delete("/:eventId", asyncRoute(cancelCalendarEvent));
calendarRouter.post("/:eventId/attendees", asyncRoute(controller.addEventAttendees));
calendarRouter.post("/:eventId/respond", asyncRoute(controller.respond));
