import { z } from "zod";

import { apiRequest } from "./api";
import type { SessionState } from "../store/session";

const identitySchema = z.object({
  access_token: z.string(),
  must_change_password: z.boolean().optional().default(false),
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
  }),
});

const meSchema = z.object({
  email: z.string().email(),
  name: z.string(),
  must_change_password: z.boolean(),
  organizations: z.array(
    z.object({
      org_id: z.string(),
      org_name: z.string(),
      org_type: z.string().nullable(),
      roles: z.array(z.string()),
    }),
  ),
});

async function hydrateSession(
  payload: z.infer<typeof identitySchema>,
): Promise<SessionState> {
  const me = meSchema.parse(
    await apiRequest("/auth/me", {
      session: { token: payload.access_token, orgId: null },
    }),
  );
  return {
    token: payload.access_token,
    orgId: me.organizations[0]?.org_id ?? null,
    name: me.name,
    email: me.email,
    mustChangePassword: me.must_change_password,
    organizations: me.organizations,
  };
}

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

function toSessionState(
  token: string,
  user: z.infer<typeof pgUserSchema>,
): SessionState {
  const roles = [
    ...(user.is_admin ? ["admin"] : []),
    ...(user.position ? [user.position.name] : []),
  ];
  const organizations = user.company
    ? [
        {
          org_id: user.company.id,
          org_name: user.company.name,
          org_type: null,
          roles,
        },
      ]
    : [];
  return {
    token,
    orgId: user.company?.id ?? null,
    name: user.name,
    email: user.email,
    mustChangePassword: false,
    organizations,
  };
}

export async function login(email: string, password: string): Promise<SessionState> {
  const payload = pgLoginSchema.parse(
    await apiRequest("/pg/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  );
  return toSessionState(payload.token, payload.user);
}

export async function signup(
  email: string,
  name: string,
  password: string,
  invitationToken?: string,
): Promise<SessionState> {
  const body: Record<string, string> = { email, name, password };
  if (invitationToken) body.invitation_token = invitationToken;
  const payload = identitySchema.parse(
    await apiRequest("/auth/signup", { method: "POST", body }),
  );
  return hydrateSession(payload);
}
