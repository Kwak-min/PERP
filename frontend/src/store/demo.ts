import { useSyncExternalStore } from "react";

const KEY = "orbitflow.demoMode";
const listeners = new Set<() => void>();

function read(): boolean {
  // 기본값 OFF: 데이터를 입력하지 않은 사용자에게 데모(fixture) 더미를 보이지 않는다.
  // 데모를 보려면 상단 토글로 켠다(localStorage "1").
  if (typeof window === "undefined") return false;
  const raw = localStorage.getItem(KEY);
  return raw === null ? false : raw === "1";
}

let current = read();

export const demoStore = {
  getSnapshot: (): boolean => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  toggle(): void {
    current = !current;
    localStorage.setItem(KEY, current ? "1" : "0");
    for (const listener of listeners) listener();
  },
};

export function useDemoMode(): boolean {
  return useSyncExternalStore(demoStore.subscribe, demoStore.getSnapshot, () => false);
}
