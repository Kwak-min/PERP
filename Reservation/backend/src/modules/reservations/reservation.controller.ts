import { NextFunction, Request, Response } from 'express';
import { reservationService } from './reservation.service';
import {
  createReservationSchema,
  updateReservationSchema,
  timetableQuerySchema,
  listQuerySchema,
} from './reservation.schema';
import { sendSuccess } from '../../common/response';

export const reservationController = {
  /**
   * @swagger
   * /api/v1/reservations:
   *   get:
   *     tags: [Reservations]
   *     summary: 예약 목록 조회
   */
  getReservations: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = listQuerySchema.parse(req.query);
      const data = await reservationService.findMany(q.spaceId, q.from, q.to, q.userId);
      sendSuccess(res, data);
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/reservations/timetable:
   *   get:
   *     tags: [Reservations]
   *     summary: 타임테이블 조회 (1시간 단위 슬롯)
   */
  getTimetable: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { spaceId, date } = timetableQuerySchema.parse(req.query);
      const data = await reservationService.getTimetable(spaceId, date);
      sendSuccess(res, data);
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/reservations/{id}:
   *   get:
   *     tags: [Reservations]
   *     summary: 예약 상세 조회
   */
  getReservationById: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await reservationService.findById(Number(req.params.id));
      sendSuccess(res, data);
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/reservations:
   *   post:
   *     tags: [Reservations]
   *     summary: 예약 생성 (반복 예약 포함)
   */
  createReservation: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = createReservationSchema.parse(req.body);
      const data = await reservationService.create(dto);
      sendSuccess(res, data, 201, '예약이 완료되었습니다.');
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/reservations/{id}:
   *   patch:
   *     tags: [Reservations]
   *     summary: 예약 수정 (본인만)
   */
  updateReservation: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = updateReservationSchema.parse(req.body);
      const userId = Number(req.query.userId);
      if (!userId || isNaN(userId)) return next(new Error('userId 쿼리파라미터가 필요합니다.'));
      const data = await reservationService.update(Number(req.params.id), userId, dto);
      sendSuccess(res, data, 200, '예약이 수정되었습니다.');
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/reservations/{id}:
   *   delete:
   *     tags: [Reservations]
   *     summary: 예약 취소 (본인만)
   */
  cancelReservation: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = Number(req.query.userId);
      if (!userId || isNaN(userId)) return next(new Error('userId 쿼리파라미터가 필요합니다.'));
      const data = await reservationService.cancel(Number(req.params.id), userId);
      sendSuccess(res, data, 200, '예약이 취소되었습니다.');
    } catch (err) { next(err); }
  },
};
