import { Router } from 'express';
import { waitlistController } from './waitlist.controller';

export const waitlistRouter = Router();

waitlistRouter.post('/', waitlistController.addWaitlist);
waitlistRouter.get('/', waitlistController.getWaitlist);
waitlistRouter.delete('/:id', waitlistController.cancelWaitlist);
