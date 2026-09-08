import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { uploadRoot } from './document-ingestion.service.js';
import { ApiError, invalid } from '../utils/errors.js';

export const RECEIPT_LIMITS = Object.freeze({ fileBytes: 10 * 1024 ** 2, count: 5, totalBytes: 25 * 1024 ** 2, pixels: 40_000_000, lifetimeMs: 24 * 3600_000 });
const formats = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
export const receiptTokensSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]{43}$/)).max(RECEIPT_LIMITS.count)
  .refine(tokens => new Set(tokens).size === tokens.length, '중복 업로드 토큰입니다.');
export const tokenHash = token => createHash('sha256').update(token).digest('hex');

export async function validateReceipt({ bytes, filename, mime }) {
  if (typeof filename !== 'string' || filename.length > 240 || !filename.trim() || /[\\/:\u0000-\u001f\u007f]/.test(filename)) throw invalid('원본 파일명에 경로 또는 제어 문자를 사용할 수 없습니다.');
  const extension = path.extname(filename).toLowerCase();
  if (!Object.hasOwn(formats, extension) || formats[extension] !== mime) throw invalid('JPEG, PNG, PDF의 확장자와 MIME이 일치해야 합니다.');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw invalid('비어 있지 않은 원본 파일이 필요합니다.');
  if (bytes.length > RECEIPT_LIMITS.fileBytes) throw new ApiError('PAYLOAD_TOO_LARGE', '파일은 10MiB 이하여야 합니다.', {}, 413);
  // pinned file-type의 ZIP/ASF parser에 임의 입력을 보내지 않는다. 실제 decode 검증은 아래에서 계속 수행한다.
  const magic = mime === 'image/jpeg' ? Buffer.from([0xff, 0xd8, 0xff])
    : mime === 'image/png' ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : Buffer.from('%PDF-');
  if (!bytes.subarray(0, magic.length).equals(magic)) throw invalid('원증빙 magic과 MIME이 일치하지 않습니다.');
  try {
    const detected = await fileTypeFromBuffer(bytes);
    if (detected?.mime !== mime) throw new Error('signature mismatch');
    if (mime === 'application/pdf') {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
      if (pdf.isEncrypted || pdf.getPageCount() < 1) throw new Error('encrypted or empty PDF');
      // 페이지 트리를 실제로 해석한다. malware scan 또는 OCR이 아니다.
      pdf.getPages().forEach(page => page.getSize());
    } else {
      const image = sharp(bytes, { limitInputPixels: RECEIPT_LIMITS.pixels, failOn: 'warning', animated: true });
      const meta = await image.metadata();
      if (meta.width * meta.height > RECEIPT_LIMITS.pixels) throw new Error('pixel limit');
      // metadata만 읽으면 손상된 pixel stream을 통과시킨다. 모든 pixel을 decode한다.
      await image.raw().toBuffer();
    }
  } catch {
    throw invalid('손상되었거나 지원하지 않는 원증빙입니다. 암호화 PDF는 허용하지 않습니다.');
  }
  return { bytes, filename, mime, extension, size_bytes: bytes.length, checksum_sha256: tokenHash(bytes) };
}

export function newReceiptStage(validated) {
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  return { ...validated, id, token, token_hash: tokenHash(token), storage_key: `receipts/${id}${validated.extension}` };
}

export function receiptPath(key) {
  if (!/^receipts\/[0-9a-f-]{36}\.(jpg|jpeg|png|pdf)$/.test(key)) throw new ApiError('INTERNAL', '원증빙 저장 키가 올바르지 않습니다.');
  return path.join(uploadRoot(), key);
}

export function writeReceipt(stage) {
  const destination = receiptPath(stage.storage_key);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, stage.bytes, { flag: 'wx', mode: 0o600 });
}
export function removeStagedReceipt(stage) { rmSync(receiptPath(stage.storage_key), { force: true }); }
export function receiptUploadView(stage, expiresAt) {
  return { token: stage.token, filename: stage.filename, mime: stage.mime, size_bytes: stage.size_bytes,
    checksum_sha256: stage.checksum_sha256, expires_at: new Date(expiresAt).toISOString() };
}
export function assertReceiptBounds(existing, uploads) {
  if (existing.count + uploads.length > RECEIPT_LIMITS.count || existing.bytes + uploads.reduce((sum, row) => sum + Number(row.size_bytes), 0) > RECEIPT_LIMITS.totalBytes) {
    throw invalid('원증빙은 최대 5개, 합계 25MiB까지 첨부할 수 있습니다.');
  }
}
