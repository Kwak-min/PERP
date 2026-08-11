import { Router } from "express";

import * as controller from "../controllers/handover.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const handoverRouter = Router();

handoverRouter.post("", asyncRoute(controller.create));
handoverRouter.get("", asyncRoute(controller.list));
handoverRouter.get("/:packageId", asyncRoute(controller.detail));
handoverRouter.post("/:packageId/items", asyncRoute(controller.addItem));
handoverRouter.post("/:packageId/submit", asyncRoute(controller.submit));
handoverRouter.post(
  "/:packageId/items/:itemId/complete",
  asyncRoute(controller.completeItem),
);
handoverRouter.post("/:packageId/confirm", asyncRoute(controller.confirm));
