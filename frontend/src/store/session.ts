import { useSyncExternalStore } from "react";
import { z } from "zod";

const membershipSchema = z.object({
  org_id: z.string(),
  org_name: z.string(),
  org_type: z.string().nullable().catch(null),
  roles: z.array(z.string()).catch([]),
});

const sessionSchema = z.object({
  token: z.string().min(1),
  orgId: z.string().nullable(),
  name: z.string(),
  email: z.string(),
  mustChangePassword: z.boolean(),
  organizations: z.array(membershipSchema),
});

export type Organization = z.infer<typeof membershipSchema>;
export type SessionState = z.infer<typeof sessionSchema>;

const STORAGE_KEY = "orbitflow.session.v1";
const listeners = new Set<() => void>();

function restore(): SessionState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const result = sessionSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

let current: SessionState | null =
  typeof window === "undefined" ? null : restore();

function emit(): void {
  for (const listener of listeners) listener();
}

export const sessionStore = {
  getSnapshot: (): SessionState | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: SessionState, persistent = true): void {
    current = sessionSchema.parse(next);
    const value = JSON.stringify(current);
    if (persistent) {
      localStorage.setItem(STORAGE_KEY, value);
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, value);
      localStorage.removeItem(STORAGE_KEY);
    }
    emit();
  },
  patch(next: Partial<SessionState>): void {
    if (!current) return;
    this.set({ ...current, ...next });
  },
  clear(): void {
    current = null;
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    emit();
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = restore();
    emit();
  });
}

export function useSession(): SessionState | null {
  return useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSnapshot,
    sessionStore.getSnapshot,
  );
}
