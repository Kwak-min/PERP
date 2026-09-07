import { NextFunction, Request, Response } from 'express';
import { attendeeService } from './attendee.service';
import { addAttendeeSchema, respondSchema } from './attendee.schema';
import { sendSuccess } from '../../common/response';
import { principalOf, requireReservationWrite } from '../../auth/principal';

export const attendeeController = {
  /**
   * @swagger
   * /api/v1/reservations/{reservationId}/attendees:
   *   get:
   *     tags: [Attendees]
   *     summary: 참석자 목록 조회
   */
  getAttendees: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await attendeeService.findByReservation(Number(req.params.reservationId), principalOf(req));
      sendSuccess(res, data);
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/reservations/{reservationId}/attendees:
   *   post:
   *     tags: [Attendees]
   *     summary: 참석자 추가 (초대 이메일 자동 발송)
   */
  addAttendee: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = addAttendeeSchema.parse(req.body);
      const principal = principalOf(req);
      requireReservationWrite(principal);
      const data = await attendeeService.add(Number(req.params.reservationId), dto, principal);
      sendSuccess(res, data, 201, '참석자를 초대했습니다.');
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/reservations/{reservationId}/attendees/{attendeeId}:
   *   delete:
   *     tags: [Attendees]
   *     summary: 참석자 제거
   */
  removeAttendee: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = principalOf(req);
      requireReservationWrite(principal);
      await attendeeService.remove(Number(req.params.reservationId), Number(req.params.attendeeId), principal);
      sendSuccess(res, null, 200, '참석자를 제거했습니다.');
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/attendees/{token}/respond:
   *   patch:
   *     tags: [Attendees]
   *     summary: 초대 수락/거절 (이메일 링크 클릭)
   */
  respondInvite: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accept } = respondSchema.parse(req.query);
      const data = await attendeeService.respond(req.params.token, accept);
      const msg = accept ? '참석을 수락했습니다.' : '참석을 거절했습니다.';
      sendSuccess(res, data, 200, msg);
    } catch (err) { next(err); }
  },
};
