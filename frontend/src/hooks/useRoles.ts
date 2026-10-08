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
    const controller = new AbortController();
    apiRequest("/members/roles", { session: { token, orgId }, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setRoles(listSchema.parse(data).items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRoles([]);
      });
    return () => controller.abort();
  }, [token, orgId]);

  return roles;
}
