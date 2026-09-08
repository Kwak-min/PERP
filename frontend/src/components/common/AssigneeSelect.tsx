import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';

const optionsSchema = z.object({ items: z.array(z.object({ value: z.string(), label: z.string() })) });
const membersSchema = z.object({ items: z.array(z.object({ user_id: z.string(), name: z.string(), status: z.string() })) });
export function AssigneeSelect({ session, value, onChange, disabled, projectId, label = '담당자' }: Readonly<{
  session: ApiSession; value: string; onChange: (value: string) => void; disabled: boolean; projectId?: string | null; label?: string;
}>) {
  const [options, setOptions] = useState<readonly { value: string; label: string }[]>([]);
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(), pg = isPgWorkspace(session.orgId);
    setReady(false); setError(null);
    const endpoint = projectId ? `${pg ? '/pg' : ''}/projects/${encodeURIComponent(projectId)}/members` : pg ? '/pg/members/options' : '/members?limit=-1';
    apiRequest(endpoint, { session, signal: controller.signal }).then(payload => {
      const items = pg || projectId ? optionsSchema.parse(payload).items : membersSchema.parse(payload).items.filter(member => member.status === 'active').map(member => ({ value: member.user_id, label: member.name }));
      if (!controller.signal.aborted) { setOptions(items); setReady(true); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [session, projectId]);
  return <><label>{label}<select aria-label={label} value={value} disabled={disabled || !ready} onChange={event => onChange(event.target.value)}>
    <option value="">담당 미지정</option>
    {value && !options.some(option => option.value === value) && <option value={value}>현재 담당자 ({value})</option>}
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>{error && <p role="alert" className="field-error">담당자 목록: {error}</p>}</>;
}
