import { ApiError } from './errors.js';

// These are the existing SQLite randomBytes(32) and PG gen_random_uuid tokens.
export function invitationToken(raw) {
  let value = String(raw ?? '').trim();
  if (value.length > 500) throw new ApiError('VALIDATION_ERROR', '초대 코드 또는 링크를 확인하세요');
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); }
    catch { throw new ApiError('VALIDATION_ERROR', '초대 링크를 확인하세요'); }
    value = url.searchParams.get('invite') ?? url.searchParams.get('token') ?? url.searchParams.get('invitation_token') ?? '';
  }
  if (!/^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)) {
    throw new ApiError('VALIDATION_ERROR', '초대 코드 또는 링크를 확인하세요');
  }
  return value;
}
