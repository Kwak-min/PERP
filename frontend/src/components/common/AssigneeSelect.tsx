import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { Button } from '../ui/Button';

const candidatesSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), department_name: z.string().nullable(), already_member: z.boolean() })) });
type Candidate = z.infer<typeof candidatesSchema>['items'][number];
type Props = Readonly<{
  session: ApiSession; value: string; onChange: (value: string) => void; disabled: boolean;
  projectId?: string | null; candidateProjectId?: string; taskId?: string; label?: string;
  onAvailabilityChange?: (available: boolean) => void; revision?: number; showAccessWarning?: boolean; canAddProjectMember?: boolean;
  memberIds?: readonly string[]; onMembersChange?: (ids: string[]) => void;
}>;
export function AssigneeSelect(props: Props) {
  return <ScopedAssigneeSelect key={`${props.session.token}:${props.session.orgId}:${props.candidateProjectId}:${props.taskId}:${props.projectId}:${props.revision}`} {...props} />;
}
function ScopedAssigneeSelect({ session, value, onChange, disabled, projectId, candidateProjectId, taskId, label = '담당자', onAvailabilityChange, showAccessWarning, canAddProjectMember = false, memberIds = [], onMembersChange }: Props) {
  const [options, setOptions] = useState<readonly Candidate[]>([]);
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [department, setDepartment] = useState(''), [retry, setRetry] = useState(0);
  const selected = options.find(option => option.id === value);
  const membershipBlocked = Boolean(projectId && selected && !selected.already_member && !canAddProjectMember);
  const available = ready && (!value || Boolean(selected)) && !membershipBlocked
    && memberIds.every(id => options.some(option => option.id === id && (option.already_member || canAddProjectMember)));
  useEffect(() => { onAvailabilityChange?.(available); }, [available, onAvailabilityChange]);
  useEffect(() => {
    const controller = new AbortController(), prefix = isPgWorkspace(session.orgId) ? '/pg' : '';
    const endpoint = candidateProjectId ? `${prefix}/projects/${encodeURIComponent(candidateProjectId)}/candidates`
      : taskId ? `${prefix}/tasks/${encodeURIComponent(taskId)}/assignees`
        : projectId ? `${prefix}/projects/${encodeURIComponent(projectId)}/task-assignees` : null;
    setReady(false); setOptions([]); setError(null);
    if (!endpoint) return () => controller.abort();
    apiRequest(endpoint, { session, signal: controller.signal }).then(payload => {
      const items = candidatesSchema.parse(payload).items;
      if (!controller.signal.aborted) { setOptions(items); setReady(true); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [session, projectId, candidateProjectId, taskId, retry]);
  const team = options.filter(option => !department || (option.department_name ?? '부서 미지정') === department);
  const filtered = team.filter(option => `${option.name} ${option.department_name ?? ''}`.normalize('NFKC').toLocaleLowerCase().includes(query.trim().normalize('NFKC').toLocaleLowerCase()));
  const optionLabel = (option: Candidate) => `${option.name}${option.department_name ? ` · ${option.department_name}` : ''}${candidateProjectId && option.already_member ? ' · 이미 소속' : ''}`;
  return <>
    <label>구성원 검색<input type="search" aria-label="구성원 검색" value={query} disabled={disabled || !ready} onChange={event => setQuery(event.target.value)} /></label>
    {(candidateProjectId || taskId || projectId) && <label>부서<select aria-label="부서" value={department} disabled={disabled || !ready} onChange={event => setDepartment(event.target.value)}><option value="">전체 부서</option>{[...new Set(options.map(option => option.department_name ?? '부서 미지정'))].sort().map(name => <option key={name} value={name}>{name}</option>)}</select></label>}
    <label>{label}<select aria-label={label} value={value} disabled={disabled || !ready} onChange={event => onChange(event.target.value)}>
      <option value="">{candidateProjectId ? '구성원 선택' : '담당 미지정'}</option>
      {value && !selected && <option value={value} disabled>선택한 구성원 (현재 선택 불가)</option>}
      {selected && !filtered.includes(selected) && <option value={value}>{optionLabel(selected)} · 선택 유지</option>}
      {filtered.map(option => <option key={option.id} value={option.id}>{optionLabel(option)}</option>)}
    </select></label>
    {onMembersChange && <fieldset className="project-task-members" disabled={disabled || !ready}>
      <legend>함께할 프로젝트 구성원 ({memberIds.length}명 선택)</legend>
      <p>업무는 하나만 만들고 담당자는 위에서 한 명을 지정합니다. 아래 선택은 프로젝트 소속 추가이며 업무별 공동 담당자나 역할 부여가 아닙니다. 기존 소속은 해제하지 않습니다.</p>
      <div className="project-task-members__actions">
        <Button type="button" tone="neutral" size="small" disabled={!canAddProjectMember || disabled || !ready} onClick={() => onMembersChange([...new Set([...memberIds, ...team.map(option => option.id)])])}>팀 전체 선택</Button>
        <Button type="button" tone="neutral" size="small" disabled={disabled || !ready} onClick={() => onMembersChange(memberIds.filter(id => !team.some(option => option.id === id)))}>팀 선택 해제</Button>
      </div>
      <small>{department || '회사 전체'} · {team.length}명 (이름 검색과 무관하게 전체 선택)</small>
      <div className="project-task-members__list">{filtered.map(option => <label key={option.id}>
        <input type="checkbox" aria-label={`함께할 구성원 ${option.name}`} checked={memberIds.includes(option.id)} disabled={!option.already_member && !canAddProjectMember}
          onChange={event => onMembersChange(event.target.checked ? [...memberIds, option.id] : memberIds.filter(id => id !== option.id))} />
        <span>{optionLabel(option)}{option.already_member ? ' · 기존 소속' : ''}</span>
      </label>)}</div>
      {memberIds.some(id => !options.some(option => option.id === id)) && ready && <p role="alert">현재 목록에 없는 선택이 있습니다. 선택을 해제한 뒤 다시 확인하세요.</p>}
      {memberIds.length > 0 && <Button type="button" tone="neutral" size="small" disabled={disabled} onClick={() => onMembersChange([])}>모든 선택 해제</Button>}
    </fieldset>}
    {!ready && !error && <p role="status">{projectId || candidateProjectId || taskId ? '구성원 목록을 불러오는 중입니다.' : '프로젝트를 먼저 선택하세요.'}</p>}
    {ready && !filtered.length && <p role="status">조건에 맞는 구성원이 없습니다.</p>}
    {ready && value && !selected && <p role="alert" className="field-error">선택한 구성원은 더 이상 배정할 수 없습니다. 다른 구성원을 선택하세요.</p>}
    {membershipBlocked && <p data-project-membership-boundary role="alert" className="field-error">이 구성원은 아직 프로젝트에 소속되지 않았습니다. 프로젝트 수정 권한이 있는 사용자에게 구성원 추가를 요청한 뒤 목록을 다시 불러오세요. 기존 프로젝트 구성원 배정이나 담당 미지정 저장은 가능합니다.</p>}
    {error && <p role="alert" className="field-error">구성원 목록: {error}</p>}
    {(ready || error) && <Button type="button" tone="neutral" size="small" disabled={disabled} onClick={() => { setReady(false); onAvailabilityChange?.(false); setRetry(current => current + 1); }}>목록 다시 불러오기</Button>}
    {showAccessWarning && value && <p data-recipient-access-warning role="note">배정으로 역할이 자동 부여되지 않습니다. 수신자에게 업무·알림 조회 권한이 없으면 확인할 수 없습니다. <Link to="/settings/roles">역할 설정 확인</Link></p>}
  </>;
}
