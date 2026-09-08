import { Router } from "express";
import { changeAssetCustody } from '../controllers/dailyCorrections.controller.js';

import * as controller from "../controllers/assets.controller.js";
import { asyncRoute } from "../middleware/error.js";

export const assetsRouter = Router();

assetsRouter.post("", asyncRoute(controller.createAsset));
assetsRouter.get("", asyncRoute(controller.listAssets));

assetsRouter.get("/reservations", asyncRoute(controller.listReservations));
assetsRouter.post("/reservations", asyncRoute(controller.reserve));
assetsRouter.post("/reservations/:reservationId/check-in", asyncRoute(controller.checkIn));
assetsRouter.delete("/reservations/:reservationId", asyncRoute(controller.cancelReservation));

assetsRouter.get("/:assetId", asyncRoute(controller.getAsset));
assetsRouter.patch('/:assetId/custody', asyncRoute(changeAssetCustody));
assetsRouter.post("/:assetId/actions", asyncRoute(controller.assetAction));
