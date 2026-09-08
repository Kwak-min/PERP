import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolvePrincipal } from '../middleware/auth.js';
import { resolvePgCompanyPrincipal } from '../middleware/pgAccess.js';
import { ApiError, invalid } from '../utils/errors.js';
import { validateReceipt, receiptPath, tokenHash, RECEIPT_LIMITS } from '../services/receipt-files.service.js';
import { stageLegacyReceipt, getLegacyReceipt } from '../services/legacy-receipt-files.service.js';
import { stagePgReceipt, getPgReceipt } from '../services/pg-receipt-files.service.js';

const raw = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: RECEIPT_LIMITS.fileBytes, inflate: false });
export function receiptRaw(req, res, next) {
  raw(req, res, error => {
    if (!error) return next();
    if (error.type === 'entity.too.large') return next(new ApiError('PAYLOAD_TOO_LARGE', '파일은 10MiB 이하여야 합니다.', {}, 413));
    if (['encoding.unsupported', 'request.aborted', 'request.size.invalid'].includes(error.type)) return next(invalid('원본 파일 요청이 올바르지 않습니다.'));
    next(error);
  });
}

export function authorizeReceiptUpload(source, kind) {
  return async (req, _res, next) => {
    if (source === 'legacy' && req.authSource === 'perp_db') throw new ApiError('PERMISSION_DENIED', 'PG 원증빙 경로를 사용하세요.');
    const principal = source === 'legacy' ? resolvePrincipal(req) : await resolvePgCompanyPrincipal(req);
    principal.require(kind === 'transaction' ? 'transaction.write' : 'approval.request');
    next();
  };
}

export function uploadReceipt(source, kind) {
  return async (req, res) => {
    if (Object.keys(req.query).length) throw invalid('원증빙 경로와 scope는 요청 본문이나 URL에서 선택할 수 없습니다.');
    let filename;
    try { filename = decodeURIComponent(req.get('X-Upload-Name') ?? ''); }
    catch { throw invalid('X-Upload-Name은 UTF-8 percent encoding이어야 합니다.'); }
    const validated = await validateReceipt({ bytes: req.body, filename, mime: req.get('Content-Type')?.split(';')[0].trim().toLowerCase() });
    // decode 동안 권한이 회수되었을 수 있으므로 현재 actor/company를 다시 인가한다.
    delete req.principal; delete req.pgCompanyPrincipal;
    const principal = source === 'legacy' ? resolvePrincipal(req) : await resolvePgCompanyPrincipal(req);
    principal.require(kind === 'transaction' ? 'transaction.write' : 'approval.request');
    const result = source === 'legacy' ? stageLegacyReceipt(principal, kind, validated) : await stagePgReceipt(principal, kind, validated);
    res.set('Cache-Control', 'private, no-store').status(201).json(result);
  };
}

export function downloadReceipt(source, kind) {
  return async (req, res) => {
    const principal = source === 'legacy' ? resolvePrincipal(req) : await resolvePgCompanyPrincipal(req);
    const target = { kind, parentId: req.params.id, fileId: req.params.fileId };
    const file = source === 'legacy' ? getLegacyReceipt(principal, target) : await getPgReceipt(principal, target);
    let bytes;
    try { bytes = await readFile(receiptPath(file.storage_key)); }
    catch (error) {
      if (error.code === 'ENOENT') throw new ApiError('SERVICE_UNAVAILABLE', '원증빙 원본을 현재 읽을 수 없습니다.');
      throw error;
    }
    if (bytes.length !== Number(file.size_bytes) || tokenHash(bytes) !== file.checksum_sha256) throw new ApiError('SERVICE_UNAVAILABLE', '원증빙 원본 무결성을 확인할 수 없습니다.');
    res.set({ 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="receipt${file.mime === 'application/pdf' ? '.pdf' : file.mime === 'image/png' ? '.png' : '.jpg'}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())}` }).send(bytes);
  };
}
