import { Router } from 'express';
import { asyncRoute } from '../middleware/error.js';
import * as controller from '../controllers/settingsRoles.controller.js';

export const settingsRouter = Router();
settingsRouter.get('/access', asyncRoute(controller.access));
settingsRouter.get('/roles', asyncRoute(controller.roles));
settingsRouter.post('/roles', asyncRoute(controller.save));
settingsRouter.patch('/roles/:roleId', asyncRoute(controller.save));
settingsRouter.delete('/roles/:roleId', asyncRoute(controller.remove));
settingsRouter.get('/members', asyncRoute(controller.members));
settingsRouter.put('/members/:membershipId/roles', asyncRoute(controller.assign));
