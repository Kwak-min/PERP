import { useEffect, useState } from "react";
import { z } from "zod";

import { apiRequest, type ApiSession } from "../services/api";

const memberSchema = z.object({
  user_id: z.string(),
  name: z.string(),
  email: z.string(),
  status: z.string().catch("active"),
});

const listSchema = z.object({ items: z.array(memberSchema) });

export type OrgMember = z.infer<typeof memberSchema>;

/** 조직 구성원 목록. 업무대행 선택이나 이름 표시(id -> name 조인)에 쓴다. */
export function useMembers(session: ApiSession | null): readonly OrgMember[] {
  const [members, setMembers] = useState<readonly OrgMember[]>([]);
  const token = session?.token ?? null;
  const orgId = session?.orgId ?? null;

  useEffect(() => {
    if (!token || !orgId) {
      setMembers([]);
      return;
    }
    const controller = new AbortController();
    apiRequest("/members?limit=200", { session: { token, orgId }, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setMembers(listSchema.parse(data).items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMembers([]);
      });
    return () => controller.abort();
  }, [token, orgId]);

  return members;
}
