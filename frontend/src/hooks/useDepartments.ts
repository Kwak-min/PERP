import { useEffect, useState } from "react";
import { z } from "zod";

import { apiRequest, type ApiSession } from "../services/api";

const departmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().nullable().catch(null),
  leader_id: z.string().nullable().catch(null),
  access_roles: z.array(z.string()).catch([]),
  can_enter: z.boolean().catch(true),
});

const listSchema = z.object({ items: z.array(departmentSchema) });

export type Department = z.infer<typeof departmentSchema>;

const cache = new Map<string, readonly Department[]>();
const pending = new Map<string, Promise<readonly Department[]>>();

function loadDepartments(
  token: string,
  orgId: string,
  signal?: AbortSignal,
): Promise<readonly Department[]> {
  const key = `${token}:${orgId}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const abortCleanup = () => {
    pending.delete(key);
  };
  signal?.addEventListener("abort", abortCleanup, { once: true });
  const request = apiRequest("/pg/members/departments", {
    session: { token, orgId },
    ...(signal ? { signal } : {}),
  })
    .then((data) => {
      const departments = listSchema.parse(data).items;
      cache.set(key, departments);
      return departments;
    })
    .finally(() => {
      signal?.removeEventListener("abort", abortCleanup);
      if (pending.get(key) === request) pending.delete(key);
    });
  pending.set(key, request);
  return request;
}

export function useDepartments(
  session: ApiSession | null,
  reloadKey = 0,
): readonly Department[] {
  const [departments, setDepartments] = useState<readonly Department[]>([]);
  const token = session?.token ?? null;
  const orgId = session?.orgId ?? null;

  useEffect(() => {
    if (!token || !orgId) {
      setDepartments([]);
      return;
    }
    let active = true;
    const controller = new AbortController();
    if (reloadKey > 0) cache.delete(`${token}:${orgId}`);
    loadDepartments(token, orgId, controller.signal)
      .then((data) => {
        if (active) setDepartments(data);
      })
      .catch(() => {
        if (active) setDepartments([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [token, orgId, reloadKey]);

  return departments;
}
