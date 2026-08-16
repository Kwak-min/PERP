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

const app = express();

// ── 미들웨어 ──────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Swagger UI ────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── 라우터 ────────────────────────────────────
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
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.message);
  }
  console.error('[Unhandled Error]', err);
  return sendError(res, 500, '서버 오류가 발생했습니다.');
});

export default app;
