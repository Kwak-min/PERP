import { screens } from "../routes/catalog";

// 초대 비밀은 로그인 유지 여부와 무관하게 현재 탭에만 둔다.
// 실제 유효성/소속/이메일 검증은 인증 후 초대 API가 담당한다.
const INVITE_KEY = "orbitflow.auth.invite.v1";
const NEXT_KEY = "orbitflow.auth.next.v1";
const internalOrigin = "https://orbitflow.invalid";
const allowedPaths = new Set([...screens.map((screen) => screen.path), "/invitations", "/onboarding/organization"]);

function invitationToken(value: string | null): string | null {
  // Existing SQLite randomBytes(32) and PostgreSQL gen_random_uuid invite tokens.
  return value && /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value) ? value : null;
}

export function parseInvitationCode(raw: string): string | null {
  const value = raw.trim();
  if (value.length > 500) return null;
  if (!/^https?:\/\//i.test(value)) return invitationToken(value);
  try {
    const params = new URL(value).searchParams;
    return invitationToken(params.get('invite') ?? params.get('token') ?? params.get('invitation_token'));
  } catch { return null; }
}

function returnPath(value: string | null): string | null {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return null;
  const url = new URL(value, internalOrigin);
  if (url.origin !== internalOrigin || !allowedPaths.has(url.pathname)) return null;
  for (const key of ["invite", "token", "invitation_token", "next"]) url.searchParams.delete(key);
  return url.pathname + url.search;
}

export function readAuthTransition(): Readonly<{ invite: string | null; next: string | null }> {
  return {
    invite: invitationToken(sessionStorage.getItem(INVITE_KEY)),
    next: returnPath(sessionStorage.getItem(NEXT_KEY)),
  };
}

export function captureAuthTransition(search: string): void {
  const params = new URLSearchParams(search);
  const requested = params.get("next");
  const next = returnPath(requested);
  const nested = next && requested ? new URL(requested, internalOrigin).searchParams.get("invite") : null;
  if (params.has("invite") || nested !== null) {
    const invite = invitationToken(params.get("invite") ?? nested);
    if (invite) sessionStorage.setItem(INVITE_KEY, invite);
    else sessionStorage.removeItem(INVITE_KEY);
  }
  if (params.has("next")) {
    if (next) sessionStorage.setItem(NEXT_KEY, next);
    else sessionStorage.removeItem(NEXT_KEY);
  }
}

export function clearInvitation(): void {
  sessionStorage.removeItem(INVITE_KEY);
}

export function consumeReturnPath(): string | null {
  const next = readAuthTransition().next;
  sessionStorage.removeItem(NEXT_KEY);
  return next;
}
