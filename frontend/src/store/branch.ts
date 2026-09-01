import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * 브랜치 = 조직 안의 부서 단위 작업 컨텍스트.
 * 휴가·근태처럼 전사 단위로 처리하는 화면은 브랜치를 무시하고,
 * 프로젝트 진척처럼 부서가 주인인 화면만 브랜치로 좁힌다.
 */
const branchSchema = z.record(z.string(), z.string().nullable());

const STORAGE_KEY = "orbitflow.branch.v1";
const listeners = new Set<() => void>();

function restore(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const result = branchSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

let current: Record<string, string | null> =
  typeof window === "undefined" ? {} : restore();

function emit(): void {
  for (const listener of listeners) listener();
}

export const branchStore = {
  getSnapshot: (): Record<string, string | null> => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  select(orgId: string, departmentId: string | null): void {
    current = { ...current, [orgId]: departmentId };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    emit();
  },
};

export function useBranch(orgId: string | null): string | null {
  const map = useSyncExternalStore(
    branchStore.subscribe,
    branchStore.getSnapshot,
    branchStore.getSnapshot,
  );
  return orgId ? (map[orgId] ?? null) : null;
}
