import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { Button } from '../ui/Button';

const optionsSchema = z.object({ items: z.array(z.object({ value: z.string(), label: z.string() })) });
const candidatesSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), department_name: z.string().nullable(), already_member: z.boolean() })) });
type Candidate = z.infer<typeof candidatesSchema>['items'][number];
type Props = Readonly<{
  session: ApiSession; value: string; onChange: (value: string) => void; disabled: boolean;
  projectId?: string | null; candidateProjectId?: string; taskId?: string; label?: string;
  onAvailabilityChange?: (available: boolean) => void; revision?: number; showAccessWarning?: boolean;
}>;
export function AssigneeSelect(props: Props) {
  return <ScopedAssigneeSelect key={`${props.session.token}:${props.session.orgId}:${props.candidateProjectId}:${props.taskId}:${props.projectId}:${props.revision}`} {...props} />;
}
function ScopedAssigneeSelect({ session, value, onChange, disabled, projectId, candidateProjectId, taskId, label = '담당자', onAvailabilityChange, showAccessWarning }: Props) {
  const [options, setOptions] = useState<readonly Candidate[]>([]);
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [department, setDepartment] = useState(''), [retry, setRetry] = useState(0);
  const available = ready && (!value || options.some(option => option.id === value));
  useEffect(() => { onAvailabilityChange?.(available); }, [available, onAvailabilityChange]);
  useEffect(() => {
    const controller = new AbortController(), prefix = isPgWorkspace(session.orgId) ? '/pg' : '';
    const endpoint = candidateProjectId ? `${prefix}/projects/${encodeURIComponent(candidateProjectId)}/candidates`
      : taskId ? `${prefix}/tasks/${encodeURIComponent(taskId)}/assignees`
        : projectId ? `${prefix}/projects/${encodeURIComponent(projectId)}/members` : null;
    setReady(false); setOptions([]); setError(null);
    if (!endpoint) return () => controller.abort();
    apiRequest(endpoint, { session, signal: controller.signal }).then(payload => {
      const items = candidateProjectId || taskId ? candidatesSchema.parse(payload).items
        : optionsSchema.parse(payload).items.map(option => ({ id: option.value, name: option.label, department_name: null, already_member: true }));
      if (!controller.signal.aborted) { setOptions(items); setReady(true); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [session, projectId, candidateProjectId, taskId, retry]);
  const filtered = options.filter(option => option.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (!department || (option.department_name ?? '부서 미지정') === department));
  const selected = options.find(option => option.id === value);
  const optionLabel = (option: Candidate) => `${option.name}${option.department_name ? ` · ${option.department_name}` : ''}${candidateProjectId && option.already_member ? ' · 이미 소속' : ''}`;
  return <>
    <label>구성원 검색<input type="search" aria-label="구성원 검색" value={query} disabled={disabled || !ready} onChange={event => setQuery(event.target.value)} /></label>
    {(candidateProjectId || taskId) && <label>부서<select aria-label="부서" value={department} disabled={disabled || !ready} onChange={event => setDepartment(event.target.value)}><option value="">전체 부서</option>{[...new Set(options.map(option => option.department_name ?? '부서 미지정'))].sort().map(name => <option key={name} value={name}>{name}</option>)}</select></label>}
    <label>{label}<select aria-label={label} value={value} disabled={disabled || !ready} onChange={event => onChange(event.target.value)}>
      <option value="">{candidateProjectId ? '구성원 선택' : '담당 미지정'}</option>
      {value && !selected && <option value={value} disabled>선택한 구성원 (현재 선택 불가)</option>}
      {selected && !filtered.includes(selected) && <option value={value}>{optionLabel(selected)} · 선택 유지</option>}
      {filtered.map(option => <option key={option.id} value={option.id}>{optionLabel(option)}</option>)}
    </select></label>
    {!ready && !error && <p role="status">{projectId || candidateProjectId || taskId ? '구성원 목록을 불러오는 중입니다.' : '프로젝트를 먼저 선택하세요.'}</p>}
    {ready && !filtered.length && <p role="status">조건에 맞는 구성원이 없습니다.</p>}
    {ready && value && !selected && <p role="alert" className="field-error">선택한 구성원은 더 이상 배정할 수 없습니다. 다른 구성원을 선택하세요.</p>}
    {error && <p role="alert" className="field-error">구성원 목록: {error}</p>}
    {(ready || error) && <Button type="button" tone="neutral" size="small" disabled={disabled} onClick={() => { setReady(false); onAvailabilityChange?.(false); setRetry(current => current + 1); }}>목록 다시 불러오기</Button>}
    {showAccessWarning && value && <p data-recipient-access-warning role="note">배정으로 역할이 자동 부여되지 않습니다. 수신자에게 업무·알림 조회 권한이 없으면 확인할 수 없습니다. <Link to="/settings/roles">역할 설정 확인</Link></p>}
  </>;
}
