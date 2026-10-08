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
    const controller = new AbortController();
    apiRequest("/members/departments", {
      session: { token, orgId },
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setDepartments(listSchema.parse(data).items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDepartments([]);
      });
    return () => controller.abort();
  }, [token, orgId, reloadKey]);

  return departments;
}
