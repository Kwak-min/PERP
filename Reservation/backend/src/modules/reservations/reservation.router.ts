import { Router } from 'express';
import type { ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { reservationController } from './reservation.controller';
import { isOccupancyConflict } from './reservation.booking';
import { AppError, ConflictError } from '../../common/errors';

export const reservationRouter = Router();

// 주의: /timetable 이 /:id 보다 먼저 등록되어야 함
reservationRouter.get('/timetable', reservationController.getTimetable);
reservationRouter.get('/', reservationController.getReservations);
reservationRouter.get('/:id', reservationController.getReservationById);
reservationRouter.post('/', reservationController.createReservation);
reservationRouter.patch('/:id', reservationController.updateReservation);
reservationRouter.delete('/:id', reservationController.cancelReservation);

const reservationErrors: ErrorRequestHandler = (error: unknown, _req, _res, next) => {
  if (isOccupancyConflict(error)) return next(new ConflictError('해당 시간대에 이미 예약이 존재합니다.'));
  // 다른 P2004까지 전역 handler의 점유 409로 바꾸지 않는다.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2004') {
    console.error('[Reservation constraint error]', error);
    return next(new AppError(500, '서버 오류가 발생했습니다.'));
  }
  next(error);
};
reservationRouter.use(reservationErrors);
