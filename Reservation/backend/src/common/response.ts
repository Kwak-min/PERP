import { Response } from 'express';

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

export const sendSuccess = <T>(res: Response, data: T, statusCode = 200, message?: string) => {
  const response: ApiResponse<T> = { success: true, data };
  if (message) response.message = message;
  return res.status(statusCode).json(response);
};

export const sendError = (res: Response, statusCode: number, message: string) => {
  const response: ApiResponse = { success: false, message };
  return res.status(statusCode).json(response);
};
