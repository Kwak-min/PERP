import { NextFunction, Request, Response } from 'express';
import { waitlistService } from './waitlist.service';
import { addWaitlistSchema, waitlistQuerySchema } from './waitlist.schema';
import { sendSuccess } from '../../common/response';

export const waitlistController = {
  /**
   * @swagger
   * /api/v1/waitlist:
   *   post:
   *     tags: [Waitlist]
   *     summary: 대기 예약 등록
   *     description: 해당 시간대에 예약이 꽉 찬 경우 대기열에 등록합니다. 앞 예약이 취소되면 자동 승격됩니다.
   */
  addWaitlist: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = addWaitlistSchema.parse(req.body);
      const data = await waitlistService.add(dto);
      sendSuccess(res, data, 202, `대기 등록이 완료되었습니다. 현재 대기 순번: ${data.position}번`);
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/waitlist:
   *   get:
   *     tags: [Waitlist]
   *     summary: 대기 목록 조회
   */
  getWaitlist: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = waitlistQuerySchema.parse(req.query);
      if (!userId) return next(new Error('userId 쿼리파라미터가 필요합니다.'));
      const data = await waitlistService.findByUser(userId);
      sendSuccess(res, data);
    } catch (err) { next(err); }
  },

  /**
   * @swagger
   * /api/v1/waitlist/{id}:
   *   delete:
   *     tags: [Waitlist]
   *     summary: 대기 취소
   */
  cancelWaitlist: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = Number(req.query.userId);
      if (!userId || isNaN(userId)) return next(new Error('userId 쿼리파라미터가 필요합니다.'));
      const data = await waitlistService.cancel(Number(req.params.id), userId);
      sendSuccess(res, data, 200, '대기가 취소되었습니다.');
    } catch (err) { next(err); }
  },
};
