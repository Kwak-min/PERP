import { useEffect, useState } from "react";
import { z } from "zod";

import { apiRequest, type ApiSession } from "../services/api";

const roleSchema = z.object({
  key: z.string(),
  label: z.string(),
  scope: z.string().catch("self"),
});

const listSchema = z.object({ items: z.array(roleSchema) });

export type OrgRole = z.infer<typeof roleSchema>;

const cache = new Map<string, readonly OrgRole[]>();
const pending = new Map<string, Promise<readonly OrgRole[]>>();

function loadRoles(
  token: string,
  orgId: string,
  signal?: AbortSignal,
): Promise<readonly OrgRole[]> {
  const key = `${token}:${orgId}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const abortCleanup = () => {
    pending.delete(key);
  };
  signal?.addEventListener("abort", abortCleanup, { once: true });
  const request = apiRequest("/members/roles", {
    session: { token, orgId },
    ...(signal ? { signal } : {}),
  })
    .then((data) => {
      const roles = listSchema.parse(data).items;
      cache.set(key, roles);
      return roles;
    })
    .finally(() => {
      signal?.removeEventListener("abort", abortCleanup);
      if (pending.get(key) === request) pending.delete(key);
    });
  pending.set(key, request);
  return request;
}

/** 브랜치 접근을 줄 수 있는 그룹(역할) 목록. */
export function useRoles(session: ApiSession | null): readonly OrgRole[] {
  const [roles, setRoles] = useState<readonly OrgRole[]>([]);
  const token = session?.token ?? null;
  const orgId = session?.orgId ?? null;

  useEffect(() => {
    if (!token || !orgId) {
      setRoles([]);
      return;
    }
    let active = true;
    const controller = new AbortController();
    loadRoles(token, orgId, controller.signal)
      .then((data) => {
        if (active) setRoles(data);
      })
      .catch(() => {
        if (active) setRoles([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [token, orgId]);

  return roles;
}
