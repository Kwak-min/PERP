import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { ApiError, apiRequest, type ApiSession } from "../services/api";

const policySchema = z.object({
  id: z.string(),
  kind: z.string(),
  default_days: z.number().catch(0),
  carryover_enabled: z.boolean().catch(false),
  carryover_max_days: z.number().catch(0),
  expiry_note: z.string().catch(""),
});

const listSchema = z.object({ items: z.array(policySchema) });

export type LeavePolicy = z.infer<typeof policySchema>;

/**
 * 조직의 휴가 정책 목록. `leave.approve` 권한이 없으면 서버가 403을 주는데,
 * 그 결과(`forbidden`)를 "관리" 탭을 보여줄지 판단하는 근거로 재사용한다.
 */
export function useLeavePolicies(
  session: ApiSession | null,
  reloadKey = 0,
): Readonly<{ policies: readonly LeavePolicy[]; forbidden: boolean; loading: boolean; reload: () => void }> {
  const [policies, setPolicies] = useState<readonly LeavePolicy[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const token = session?.token ?? null;
  const orgId = session?.orgId ?? null;

  useEffect(() => {
    if (!token || !orgId) {
      setPolicies([]);
      setForbidden(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    apiRequest("/pg/hr/leave-policies", { session: { token, orgId }, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setPolicies(listSchema.parse(data).items);
        setForbidden(false);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setPolicies([]);
        setForbidden(caught instanceof ApiError && caught.status === 403);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, orgId, reloadKey, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  return { policies, forbidden, loading, reload };
}
