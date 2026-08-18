import { Router } from 'express';
import { reservationController } from './reservation.controller';

export const reservationRouter = Router();

// 주의: /timetable 이 /:id 보다 먼저 등록되어야 함
reservationRouter.get('/timetable', reservationController.getTimetable);
reservationRouter.get('/', reservationController.getReservations);
reservationRouter.get('/:id', reservationController.getReservationById);
reservationRouter.post('/', reservationController.createReservation);
reservationRouter.patch('/:id', reservationController.updateReservation);
reservationRouter.delete('/:id', reservationController.cancelReservation);
