// 목업 화면용 공용 데이터 훅 — 현재 세션으로 백엔드를 호출한다.
import { useCallback, useEffect, useState } from "react";

import { apiRequest, userMessageOf } from "../../services/api";
import { sessionStore, useSession } from "../../store/session";

export type ApiState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

export function useApi<T = unknown>(path: string | null): ApiState<T> {
  const session = useSession();
  const token = session?.token ?? null;
  const orgId = session?.orgId ?? null;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path || !token) {
      setData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiRequest(path, { session: { token, orgId }, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res as T);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(userMessageOf(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, token, orgId, tick]);

  return { data, loading, error, reload };
}

// 현재 세션으로 쓰기 요청(POST/PATCH/DELETE)을 보낸다.
export async function apiMutate(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const session = sessionStore.getSnapshot();
  const apiSession = session ? { token: session.token, orgId: session.orgId } : null;
  return apiRequest(path, { method, body, session: apiSession });
}
