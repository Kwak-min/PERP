import { useSyncExternalStore } from "react";

const KEY = "orbitflow.agent.useVault";
const listeners = new Set<() => void>();

function read(): boolean {
  if (typeof window === "undefined") return true;
  const raw = localStorage.getItem(KEY);
  return raw === null ? true : raw === "1";
}

let current = read();

export const vaultPrefStore = {
  getSnapshot: (): boolean => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: boolean): void {
    current = next;
    localStorage.setItem(KEY, next ? "1" : "0");
    for (const listener of listeners) listener();
  },
};

export function useVaultPref(): boolean {
  return useSyncExternalStore(vaultPrefStore.subscribe, vaultPrefStore.getSnapshot, () => true);
}
