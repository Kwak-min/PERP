import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import { spaceRouter } from './modules/spaces/space.router';
import { reservationRouter } from './modules/reservations/reservation.router';
import { attendeeRouter } from './modules/attendees/attendee.router';
import { waitlistRouter } from './modules/waitlist/waitlist.router';
import { AppError } from './common/errors';
import { sendError } from './common/response';
import { authenticate } from './auth/principal';
import { attendeeController } from './modules/attendees/attendee.controller';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

const app = express();

// ── 미들웨어 ──────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Swagger UI ────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── 라우터 ────────────────────────────────────
app.patch('/api/v1/attendees/:token/respond', attendeeController.respondInvite);
app.use('/api/v1', authenticate);
app.use('/api/v1/spaces', spaceRouter);
app.use('/api/v1/reservations', reservationRouter);
app.use('/api/v1', attendeeRouter);
app.use('/api/v1/waitlist', waitlistRouter);

// ── 헬스체크 ─────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 글로벌 에러 핸들러 ────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return sendError(res, 400, '입력값이 올바르지 않습니다.');
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2004') {
    return sendError(res, 409, '해당 시간대에 이미 예약이 존재합니다.');
  }
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.message);
  }
  console.error('[Unhandled Error]', err);
  return sendError(res, 500, '서버 오류가 발생했습니다.');
});

export default app;
