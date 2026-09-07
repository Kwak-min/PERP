import { useEffect, useState } from "react";
import { z } from "zod";

import { ApiError, apiRequest, type ApiSession } from "../services/api";

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
): Promise<readonly Department[]> {
  const key = `${token}:${orgId}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  // 공유 요청은 한 구독자가 화면을 떠나도 다른 구독자를 위해 완료한다.
  const request = apiRequest("/pg/members/departments", {
    session: { token, orgId },
  })
    .then((data) => {
      const departments = listSchema.parse(data).items;
      cache.set(key, departments);
      return departments;
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
  pending.set(key, request);
  return request;
}

type DepartmentResource = Readonly<{
  departments: readonly Department[];
  status: "idle" | "loading" | "ready" | "empty" | "forbidden" | "error";
  error: Error | null;
}>;

export function useDepartmentResource(
  session: ApiSession | null,
  reloadKey = 0,
): DepartmentResource {
  const token = session?.token ?? null;
  const orgId = session?.orgId ?? null;
  const key = token && orgId ? `${token}:${orgId}:${reloadKey}` : null;
  const [state, setState] = useState<DepartmentResource & { key: string | null }>({
    key: null, departments: [], status: "idle", error: null,
  });

  useEffect(() => {
    if (!token || !orgId) return;
    let active = true;
    if (reloadKey > 0) cache.delete(`${token}:${orgId}`);
    loadDepartments(token, orgId)
      .then((departments) => {
        if (active) setState({ key, departments, status: departments.length ? "ready" : "empty", error: null });
      })
      .catch((error: unknown) => {
        if (active) setState({
          key, departments: [],
          status: error instanceof ApiError && error.status === 403 ? "forbidden" : "error",
          error: error instanceof Error ? error : new Error("부서 응답을 확인할 수 없습니다."),
        });
      });
    return () => { active = false; };
  }, [token, orgId, reloadKey, key]);

  // 조직 전환 직후에도 이전 조직의 부서를 한 프레임도 노출하지 않는다.
  if (!key) return { departments: [], status: "idle", error: null };
  if (state.key !== key) return { departments: [], status: "loading", error: null };
  return state;
}

export function useDepartments(session: ApiSession | null, reloadKey = 0): readonly Department[] {
  return useDepartmentResource(session, reloadKey).departments;
}
