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

export async function login(email: string, password: string): Promise<SessionState> {
  const payload = identitySchema.parse(
    await apiRequest("/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  );
  return hydrateSession(payload);
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
