import { createContext, useContext, useEffect, useState } from 'react';
import { z } from 'zod';
import { apiRequest, userMessageOf, type ApiSession } from '../services/api';
import type { ScreenDefinition } from '../routes/catalog';

const accessSchema = z.object({ org_id: z.string(), permissions: z.array(z.string()), modules: z.array(z.string()),
  features: z.array(z.string()), menus: z.array(z.string()), scope: z.string() });
export type WorkspaceAccess = z.infer<typeof accessSchema>;
export const AccessContext = createContext<WorkspaceAccess | null>(null);
export const useAccess = () => useContext(AccessContext);
export function notifyAccessChanged(): void { window.dispatchEvent(new Event('orbitflow:access-changed')); }

export function canOpenScreen(access: WorkspaceAccess, screen: ScreenDefinition): boolean {
  const granted = !screen.permission || access.permissions.includes('*') || access.menus.includes(screen.permission);
  const available = screen.feature ? access.features.includes(screen.feature)
    : screen.id === 'PRJ-001' ? access.modules.includes('projects') || access.modules.includes('tasks')
      : !screen.module || access.modules.includes(screen.module);
  return granted && available;
}

export function useWorkspaceAccess(session: ApiSession | null, pathname: string) {
  const key = `${session?.token}:${session?.orgId}:${pathname}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data: WorkspaceAccess | null; error: string | null }>({ key: '', data: null, error: null });
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener('orbitflow:access-changed', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('orbitflow:access-changed', refresh); };
  }, []);
  useEffect(() => {
    if (!session?.orgId) return;
    const controller = new AbortController();
    apiRequest('/settings/access', { session, signal: controller.signal }).then(payload => {
      const data = accessSchema.parse(payload);
      if (!controller.signal.aborted) setState({ key, data, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ key, data: null, error: userMessageOf(error) });
    });
    return () => controller.abort();
  }, [key, revision, session?.token, session?.orgId]);
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null,
    retry: () => setRevision(value => value + 1) };
}
