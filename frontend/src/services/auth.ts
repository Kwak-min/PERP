import { z } from "zod";

import { apiRequest } from "./api";
import type { SessionState } from "../store/session";

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
  const payload = pgLoginSchema.parse(
    await apiRequest("/pg/auth/signup", { method: "POST", body }),
  );
  return toSessionState(payload.token, payload.user);
}
