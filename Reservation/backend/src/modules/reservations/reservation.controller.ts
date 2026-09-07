import { NextFunction, Request, Response } from 'express';
import { reservationService } from './reservation.service';
import {
  createReservationSchema,
  updateReservationSchema,
  timetableQuerySchema,
  listQuerySchema,
} from './reservation.schema';
import { sendSuccess } from '../../common/response';
import { principalOf, requireReservationWrite } from '../../auth/principal';

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
      const data = await reservationService.findMany(principalOf(req), q.spaceId, q.from, q.to, q.mine === 'true');
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
      const { spaceId, date, slotMinutes } = timetableQuerySchema.parse(req.query);
      const data = await reservationService.getTimetable(principalOf(req), spaceId, date, slotMinutes);
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
      const data = await reservationService.findById(Number(req.params.id), principalOf(req));
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
      const principal = principalOf(req);
      requireReservationWrite(principal);
      const data = await reservationService.create(dto, principal);
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
      const principal = principalOf(req);
      requireReservationWrite(principal);
      const data = await reservationService.update(Number(req.params.id), principal, dto);
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
      const principal = principalOf(req);
      requireReservationWrite(principal);
      const rawScope = req.query.cancelScope as string | undefined;
      const validScopes = ['THIS', 'THIS_AND_FOLLOWING', 'ALL'] as const;
      const cancelScope = validScopes.includes(rawScope as typeof validScopes[number])
        ? (rawScope as typeof validScopes[number])
        : 'THIS';

      const data = await reservationService.cancel(Number(req.params.id), principal, cancelScope);
      sendSuccess(res, data, 200, '예약이 취소되었습니다.');
    } catch (err) { next(err); }
  },
};
