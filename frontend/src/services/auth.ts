import { z } from "zod";

import { ApiError, apiRequest } from "./api";
import { sessionStore, type Organization, type SessionState } from "../store/session";

// --- perp_db (PostgreSQL) 인증 슬라이스 연동 ---
// 백엔드 /api/v1/pg/auth/* 응답 형태를 기존 SessionState 로 매핑한다.
const pgUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  is_admin: z.boolean().catch(false),
  company: z.object({ id: z.string(), name: z.string() }).nullable().catch(null),
  department: z.object({ id: z.string(), name: z.string() }).nullable().catch(null),
  position: z.object({ id: z.string(), name: z.string() }).nullable().catch(null),
});

const pgLoginSchema = z.object({
  token: z.string(),
  user: pgUserSchema,
});

const legacyLoginSchema = z.object({
  access_token: z.string(),
  must_change_password: z.boolean().catch(false),
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});

// 레거시(SQLite) 소속 조직. 온보딩으로 만든 조직은 여기에 남고,
// perp_db 세션 브리지 덕분에 같은 토큰으로 조회된다.
const legacyMeSchema = z.object({
  organizations: z
    .array(
      z.object({
        org_id: z.string(),
        org_name: z.string(),
        org_type: z.string().nullable(),
        roles: z.array(z.string()),
      }),
    ),
});

// 저장소 라우팅에만 사용한다. 신원과 회사 소속/권한은 서버가 별도로 검증한다.
export function isPgToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

/** 메뉴 개인화에는 인증 저장소가 반환한 불변 사용자 ID만 사용한다. */
export async function authenticatedUserId(token: string, signal: AbortSignal): Promise<string> {
  const session = { token, orgId: null };
  if (isPgToken(token)) {
    const payload = z.object({ user: z.object({ id: z.string().min(1) }) }).parse(
      await apiRequest('/pg/auth/me', { session, signal }),
    );
    return payload.user.id;
  }
  return z.object({ id: z.string().min(1) }).parse(
    await apiRequest('/auth/me', { session, signal }),
  ).id;
}

/** 검증된 계정의 운영 조직 소속만 조회한다. 조회 실패는 빈 소속과 구분한다. */
export async function organizationsOf(token: string): Promise<readonly Organization[]> {
  // UUID PG 토큰은 perp_db 워크스페이스가 유일한 권위 소스다.
  // 레거시 SQLite(/auth/me)는 조회하지 않는다 — 옛 소속이 pg 회사보다 먼저 선택돼
  // pg 세션을 레거시 인증 경로로 보내 접근이 차단되던 문제를 근본 제거한다.
  if (isPgToken(token)) {
    const pg = legacyMeSchema.parse(await apiRequest("/pg/auth/workspace", { session: { token, orgId: null } }));
    return pg.organizations;
  }
  // 레거시 폴백 로그인(비-PG 토큰)만 기존 SQLite 소속을 사용한다.
  const parsed = legacyMeSchema.parse(
    await apiRequest("/auth/me", { session: { token, orgId: null } }),
  );
  return parsed.organizations;
}

function toSessionState(
  token: string,
  user: Readonly<{ name: string; email: string }>,
  mustChangePassword = false,
): SessionState {
  const previous = sessionStore.getSnapshot();
  // 인증 성공과 소속 조회는 별도 단계다. 생성된 토큰부터 화면에서 저장한다.
  return {
    token,
    orgId: null,
    name: user.name,
    email: user.email,
    mustChangePassword,
    organizations: [],
    organizationStatus: "loading",
    preferredOrgId: previous?.email.toLowerCase() === user.email.toLowerCase() ? previous.orgId : null,
  };
}

/** 실패하면 인증 상태를 유지하고, 재시도는 소속만 조회한다. */
export async function loadSessionOrganizations(token: string): Promise<readonly Organization[]> {
  const organizations = await organizationsOf(token);
  const current = sessionStore.getSnapshot();
  // 로그아웃/다른 계정 로그인 뒤 도착한 응답은 새 세션에 적용하지 않는다.
  if (current?.token === token) {
    sessionStore.patch({
      organizations: [...organizations],
      orgId: organizations.find((org) => org.org_id === current.preferredOrgId)?.org_id
        ?? organizations[0]?.org_id ?? null,
      organizationStatus: "ready",
      preferredOrgId: null,
    });
  }
  return organizations;
}

export async function login(email: string, password: string): Promise<SessionState> {
  let payload: z.infer<typeof pgLoginSchema>;
  try {
    payload = pgLoginSchema.parse(
      await apiRequest("/pg/auth/login", { method: "POST", body: { email, password } }),
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401 && error.code === "UNAUTHENTICATED")) {
      throw error;
    }
    // 두 저장소 계약: PG의 계정 없음/비밀번호 불일치(401 UNAUTHENTICATED)만
    // 레거시 자격 증명 검증을 허용한다. 장애·차단·응답 오류는 전파한다.
    const payload = legacyLoginSchema.parse(
      await apiRequest("/auth/login", { method: "POST", body: { email, password } }),
    );
    return toSessionState(payload.access_token, payload.user, payload.must_change_password);
  }
  return toSessionState(payload.token, payload.user);
}

export async function signup(
  email: string,
  name: string,
  password: string,
): Promise<SessionState> {
  const body = { email, name, password };
  const payload = pgLoginSchema.parse(
    await apiRequest("/pg/auth/signup", { method: "POST", body }),
  );
  // 초대 확인/수락은 인증 후 별도 화면에서 명시적으로 실행한다.
  return toSessionState(payload.token, payload.user);
}

export async function logout(token: string, orgId: string | null): Promise<void> {
  await apiRequest("/auth/logout", {
    method: "POST",
    session: { token, orgId },
  });
}
