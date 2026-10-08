import { useEffect, useState } from "react";

import { ApiError, apiRequest, type ApiSession } from "../services/api";
import { sessionStore } from "../store/session";

type ResourceState =
  | Readonly<{ status: "idle"; data: null; error: null }>
  | Readonly<{ status: "loading"; data: null; error: null }>
  | Readonly<{ status: "ready"; data: unknown; error: null }>
  | Readonly<{ status: "empty"; data: unknown; error: null }>
  | Readonly<{ status: "forbidden"; data: null; error: ApiError }>
  | Readonly<{ status: "error"; data: null; error: Error }>;

function isEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as { items?: unknown }).items;
    return Array.isArray(items) && items.length === 0;
  }
  return false;
}

export function useResource(
  path: string | null,
  session: ApiSession | null,
  reloadKey = 0,
): ResourceState {
  const [state, setState] = useState<ResourceState>({
    status: "idle",
    data: null,
    error: null,
  });

  const [freshness, setFreshness] = useState(0);
  useEffect(() => {
    const refresh = () => setFreshness(value => value + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener('orbitflow:access-changed', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('orbitflow:access-changed', refresh); };
  }, []);

  useEffect(() => {
    if (!path || !session) {
      setState({ status: "idle", data: null, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading", data: null, error: null });
    apiRequest(path, { session, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({
          status: isEmpty(data) ? "empty" : "ready",
          data,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          sessionStore.clear();
          setState({ status: "error", data: null, error });
          return;
        }
        if (error instanceof ApiError && error.status === 403) {
          setState({ status: "forbidden", data: null, error });
          return;
        }
        setState({
          status: "error",
          data: null,
          error: error instanceof Error ? error : new Error("Unknown error"),
        });
      });
    return () => controller.abort();
  }, [path, session, reloadKey, freshness]);

  return state;
}
