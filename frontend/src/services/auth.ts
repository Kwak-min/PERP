import { z } from "zod";

import { apiRequest } from "./api";
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

// 레거시(SQLite) 소속 조직. 온보딩으로 만든 조직은 여기에 남고,
// perp_db 세션 브리지 덕분에 같은 토큰으로 조회된다.
const legacyMeSchema = z.object({
  organizations: z
    .array(
      z.object({
        org_id: z.string(),
        org_name: z.string(),
        org_type: z.string().nullable().catch(null),
        roles: z.array(z.string()).catch([]),
      }),
    )
    .catch([]),
});

/** 이 계정이 실제로 들어갈 수 있는 조직 전부(perp_db 소속 회사 + 레거시 소속). */
export async function organizationsOf(token: string): Promise<readonly Organization[]> {
  try {
    const parsed = legacyMeSchema.parse(
      await apiRequest("/auth/me", { session: { token, orgId: null } }),
    );
    return parsed.organizations;
  } catch {
    // 레거시 소속이 없거나 조회에 실패해도 로그인 자체는 막지 않는다.
    return [];
  }
}

function mergeOrganizations(
  first: readonly Organization[],
  second: readonly Organization[],
): readonly Organization[] {
  const merged = [...first];
  for (const org of second) {
    if (!merged.some((item) => item.org_id === org.org_id)) merged.push(org);
  }
  return merged;
}

async function toSessionState(
  token: string,
  user: z.infer<typeof pgUserSchema>,
): Promise<SessionState> {
  const roles = [
    ...(user.is_admin ? ["admin"] : []),
    ...(user.position ? [user.position.name] : []),
  ];
  const fromPg: readonly Organization[] = user.company
    ? [
        {
          org_id: user.company.id,
          org_name: user.company.name,
          org_type: null,
          roles,
        },
      ]
    : [];
  const organizations = mergeOrganizations(fromPg, await organizationsOf(token));
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
  const payload = pgLoginSchema.parse(
    await apiRequest("/pg/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  );
  return await toSessionState(payload.token, payload.user);
}

export async function signup(
  email: string,
  name: string,
  password: string,
  invitationToken?: string,
): Promise<SessionState> {
  const body: Record<string, string> = { email, name, password };
  if (invitationToken) body.invitation_token = invitationToken;
  const payload = pgLoginSchema.parse(
    await apiRequest("/pg/auth/signup", { method: "POST", body }),
  );
  return await toSessionState(payload.token, payload.user);
}
