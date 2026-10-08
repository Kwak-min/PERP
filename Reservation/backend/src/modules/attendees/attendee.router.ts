import { Router } from 'express';
import { attendeeController } from './attendee.controller';

export const attendeeRouter = Router();

attendeeRouter.get('/reservations/:reservationId/attendees', attendeeController.getAttendees);
attendeeRouter.post('/reservations/:reservationId/attendees', attendeeController.addAttendee);
attendeeRouter.delete('/reservations/:reservationId/attendees/:attendeeId', attendeeController.removeAttendee);
