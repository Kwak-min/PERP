import { NextFunction, Request, Response } from 'express';
import { spaceService } from './space.service';
import { createSpaceSchema, updateSpaceSchema, spaceAvailabilitySchema } from './space.schema';
import { sendSuccess } from '../../common/response';
import { principalOf, requireSpaceAdmin } from '../../auth/principal';

export const spaceController = {
  /**
   * @swagger
   * /api/v1/spaces:
   *   get:
   *     tags: [Spaces]
   *     summary: 공간 목록 조회
   *     parameters:
   *       - in: query
   *         name: minCapacity
   *         schema: { type: integer }
   *       - in: query
   *         name: startTime
   *         schema: { type: string, format: date-time }
   *       - in: query
   *         name: endTime
   *         schema: { type: string, format: date-time }
   */
  getSpaces: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = spaceAvailabilitySchema.parse(req.query);
      const spaces = await spaceService.findAvailable(
        principalOf(req),
        query.minCapacity,
        query.startTime,
        query.endTime,
      );
      sendSuccess(res, spaces);
    } catch (err) {
      next(err);
    }
  },

  /**
   * @swagger
   * /api/v1/spaces/{id}:
   *   get:
   *     tags: [Spaces]
   *     summary: 공간 상세 조회
   */
  getSpaceById: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const space = await spaceService.findById(Number(req.params.id), principalOf(req));
      sendSuccess(res, space);
    } catch (err) {
      next(err);
    }
  },

  /**
   * @swagger
   * /api/v1/spaces:
   *   post:
   *     tags: [Spaces]
   *     summary: 공간 등록
   */
  createSpace: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createSpaceSchema.parse(req.body);
      const principal = principalOf(req);
      requireSpaceAdmin(principal);
      const space = await spaceService.create(data, principal);
      sendSuccess(res, space, 201, '공간이 등록되었습니다.');
    } catch (err) {
      next(err);
    }
  },

  /**
   * @swagger
   * /api/v1/spaces/{id}:
   *   patch:
   *     tags: [Spaces]
   *     summary: 공간 수정
   */
  updateSpace: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = updateSpaceSchema.parse(req.body);
      const principal = principalOf(req);
      requireSpaceAdmin(principal);
      const space = await spaceService.update(Number(req.params.id), data, principal);
      sendSuccess(res, space, 200, '공간이 수정되었습니다.');
    } catch (err) {
      next(err);
    }
  },

  /**
   * @swagger
   * /api/v1/spaces/{id}:
   *   delete:
   *     tags: [Spaces]
   *     summary: 공간 삭제 (soft delete)
   */
  deleteSpace: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = principalOf(req);
      requireSpaceAdmin(principal);
      await spaceService.delete(Number(req.params.id), principal);
      sendSuccess(res, null, 200, '공간이 삭제되었습니다.');
    } catch (err) {
      next(err);
    }
  },
};
