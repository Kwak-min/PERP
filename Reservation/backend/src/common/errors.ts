// ──────────────────────────────────────────────
// 커스텀 에러 클래스
// ──────────────────────────────────────────────

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = '리소스를 찾을 수 없습니다.') {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = '이미 존재하는 리소스입니다.') {
    super(409, message);
    this.name = 'ConflictError';
  }
}

export class BadRequestError extends AppError {
  constructor(message = '잘못된 요청입니다.') {
    super(400, message);
    this.name = 'BadRequestError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '접근 권한이 없습니다.') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}
