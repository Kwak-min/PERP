import { z } from "zod";

import { ApiError, apiRequest } from "./api";
import type { Organization, SessionState } from "../store/session";

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

/** 검증된 계정의 운영 조직 소속만 조회한다. 조회 실패는 빈 소속과 구분한다. */
export async function organizationsOf(token: string): Promise<readonly Organization[]> {
  const parsed = legacyMeSchema.parse(
    await apiRequest("/auth/me", { session: { token, orgId: null } }),
  );
  // UUID PG 토큰은 서버가 검증한 별도 PG 회사 목록을 가져온다.
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(token)) {
    const pg = legacyMeSchema.parse(await apiRequest("/pg/auth/workspace", { session: { token, orgId: null } }));
    return [...parsed.organizations, ...pg.organizations];
  }
  return parsed.organizations;
}

async function toSessionState(
  token: string,
  user: z.infer<typeof pgUserSchema>,
): Promise<SessionState> {
  // PG 회사/직책/관리자 값은 운영 조직 소속이나 역할이 아니다.
  const organizations = await organizationsOf(token);
  return {
    token,
    // 한 곳뿐이면 바로 들어가고, 없거나 여러 곳이면 /welcome 에서 고르게 한다.
    orgId: organizations.length === 1 ? (organizations[0] as Organization).org_id : null,
    name: user.name,
    email: user.email,
    mustChangePassword: false,
    organizations: [...organizations],
  };
}

export async function login(email: string, password: string): Promise<SessionState> {
  let payload: z.infer<typeof pgLoginSchema>;
  try {
    payload = pgLoginSchema.parse(
      await apiRequest("/pg/auth/login", { method: "POST", body: { email, password } }),
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE")) {
      throw error;
    }
    // PG 장애 때도 레거시 계정은 별도 비밀번호 검증을 통과해야 한다.
    const payload = legacyLoginSchema.parse(
      await apiRequest("/auth/login", { method: "POST", body: { email, password } }),
    );
    return {
      token: payload.access_token,
      // 레거시 로그인은 소속이 하나여도 사용자가 선택하도록 한다.
      orgId: null,
      name: payload.user.name,
      email: payload.user.email,
      mustChangePassword: payload.must_change_password,
      organizations: [...await organizationsOf(payload.access_token)],
    };
  }
  // 소속 조회 장애는 PG 로그인 장애가 아니며 다른 인증 저장소로 전환하지 않는다.
  return await toSessionState(payload.token, payload.user);
}

export async function signup(
  email: string,
  name: string,
  password: string,
  invitationToken?: string,
  companyName?: string,
): Promise<SessionState> {
  const body: Record<string, string> = { email, name, password };
  if (invitationToken) body.invitation_token = invitationToken;
  if (companyName) body.company_name = companyName;
  const payload = pgLoginSchema.parse(
    await apiRequest("/pg/auth/signup", { method: "POST", body }),
  );
  let session = await toSessionState(payload.token, payload.user);
  if (invitationToken) {
    await apiRequest("/auth/invitations/accept", {
      method: "POST",
      session: { token: payload.token, orgId: null },
      body: { token: invitationToken },
    });
    const organizations = await organizationsOf(payload.token);
    session = {
      ...session,
      organizations: [...organizations],
      orgId: organizations.length === 1 ? organizations[0]!.org_id : null,
    };
  }
  return session;
}

export async function logout(token: string, orgId: string | null): Promise<void> {
  await apiRequest("/auth/logout", {
    method: "POST",
    session: { token, orgId },
  });
}
