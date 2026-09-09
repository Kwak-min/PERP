import express from 'express';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { ApiError } from '../utils/errors.js';
import { ExpenseCsvError, EXPENSE_CSV_LIMITS } from '../services/expense-csv.service.js';
import { resolvePrincipal } from '../middleware/auth.js';
import * as imports from '../services/expense-import.service.js';

const raw = express.raw({ type: 'text/csv', limit: EXPENSE_CSV_LIMITS.rawBytes, inflate: false });
export function expenseImportRaw(req, res, next) {
  raw(req, res, error => {
    if (!error) return next();
    next(new ApiError(error.type === 'entity.too.large' ? 'CSV_FILE_TOO_LARGE' : 'VALIDATION_ERROR',
      'CSV 원본 요청의 형식 또는 5MiB 크기 한도를 확인하세요.', {}, error.type === 'entity.too.large' ? 413 : 400));
  });
}
export function authorizeExpenseImport(source) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (source === 'legacy') {
      if (req.authSource === 'perp_db') throw new ApiError('PERMISSION_DENIED', 'PG 가져오기 경로를 사용하세요.');
      const principal = resolvePrincipal(req);
      principal.require('transaction.write'); principal.require('transaction.confirm');
    } else {
      (await resolvePgCompanyPrincipal(req)).require('transaction.write');
    }
    next();
  };
}
export function expenseImportHandler(source, operation) {
  const methods = source === 'legacy'
    ? { upload: imports.stageLegacyExpenseImport, preview: imports.previewLegacyExpenseImport, read: imports.readLegacyExpenseImport, commit: imports.commitLegacyExpenseImport }
    : { upload: imports.stagePgExpenseImport, preview: imports.previewPgExpenseImport, read: imports.readPgExpenseImport, commit: imports.commitPgExpenseImport };
  return async (req, res) => {
    if (operation !== 'rows' && Object.keys(req.query).length) throw new ApiError('VALIDATION_ERROR', '이 경로는 query override를 받지 않습니다.');
    if (operation === 'commit' && req.hasJsonBody !== true) throw new ApiError('VALIDATION_ERROR', 'JSON 빈 객체 본문이 필요합니다.');
    try {
      const result = operation === 'upload' ? await methods.upload(req, req.body)
        : operation === 'rows' ? await methods.read(req, true) : await methods[operation](req);
      res.status(['upload','preview'].includes(operation) ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof ExpenseCsvError) throw new ApiError(error.code, 'CSV 형식 또는 매핑을 확인하세요.', error.details, error.status);
      throw error;
    }
  };
}
