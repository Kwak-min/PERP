import { useEffect, useRef, useState } from 'react';
import { apiRequest, ApiError, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { parseTasks, type Task } from './model';

// 초안과 서버 기준을 분리한다. 충돌 뒤 최신 조회는 사용자가 명시적으로 실행한다.
export function useTaskVersion(task: Task | null, session: ApiSession) {
  const [latest, setLatest] = useState(task);
  const [state, setState] = useState<'current' | 'stale' | 'loading' | 'refreshed'>('current');
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const controller = useRef(new AbortController());
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    return () => active.abort();
  }, []);
  const fail = (caught: unknown) => {
    if (controller.current.signal.aborted) return;
    if (caught instanceof ApiError && caught.status === 409) { setState('stale'); setError(null); }
    else setError(userMessageOf(caught));
  };
  async function refresh(): Promise<void> {
    if (!latest || state === 'loading') return;
    setState('loading'); setError(null);
    const pg = isPgWorkspace(session.orgId);
    try {
      const payload = await apiRequest(pg ? `/pg/tasks?task_id=${encodeURIComponent(latest.id)}` : `/tasks/${encodeURIComponent(latest.id)}`, { session, signal: controller.current.signal });
      const refreshed = parseTasks(pg ? payload : { items: [payload] }, pg).find(item => item.id === latest.id);
      if (!refreshed || refreshed.version === undefined) throw new ApiError('최신 업무와 버전을 확인할 수 없습니다.', { code: 'INVALID_RESPONSE', status: 409, requestId: '', details: {} });
      if (!controller.current.signal.aborted) { setLatest(refreshed); setRefreshCount(value => value + 1); setState('refreshed'); }
    } catch (caught: unknown) {
      if (!controller.current.signal.aborted) { setState('stale'); setError(userMessageOf(caught)); }
    }
  }
  return { latest, state, error, fail, refresh, refreshCount, get signal() { return controller.current.signal; },
    writable: latest?.version !== undefined && (state === 'current' || state === 'refreshed') };
}
