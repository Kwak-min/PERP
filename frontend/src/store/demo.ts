import { useSyncExternalStore } from "react";

const KEY = "orbitflow.demoMode";
const listeners = new Set<() => void>();

function read(): boolean {
  // 명시적으로 켠 데모만 표시한다.
  if (typeof window === "undefined") return false;
  const raw = localStorage.getItem(KEY);
  return raw === "1";
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
