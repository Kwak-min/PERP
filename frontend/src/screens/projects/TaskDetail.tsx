import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { AssigneeSelect } from '../../components/common/AssigneeSelect';
import { Button } from '../../components/ui/Button';
import { statusLabel, taskStatuses, type Project, type Task } from './model';
import { useTaskVersion } from './useTaskVersion';

export function TaskDetail({ task, project, session, disabled, administrator, onSaved }: Readonly<{
  task: Task; project: Project | undefined; session: ApiSession; disabled: boolean; administrator: boolean; onSaved: () => void;
}>) {
  const [title, setTitle] = useState(task.title), [status, setStatus] = useState(task.status), [due, setDue] = useState(task.due_at?.slice(0, 10) ?? '');
  const [assignee, setAssignee] = useState(task.assignee_id ?? '');
  const [available, setAvailable] = useState(false), [saving, setSaving] = useState(false);
  const version = useTaskVersion(task, session);
  const locked = disabled || saving || !available || !version.writable;
  async function submit(): Promise<void> {
    if (locked || !title.trim()) return;
    setSaving(true);
    const pg = isPgWorkspace(session.orgId);
    try {
      await apiRequest(`${pg ? '/pg' : ''}/tasks/${encodeURIComponent(task.id)}`, { session, signal: version.signal, method: 'PATCH', body: {
        version: version.latest?.version, title: title.trim(), status, ...(pg ? { due_on: due || null } : { due_at: due }),
        ...(assignee !== (version.latest?.assignee_id ?? '') ? { assignee_id: assignee || null } : {}),
      } });
      if (!version.signal.aborted) onSaved();
    } catch (caught: unknown) { version.fail(caught); }
    finally { if (!version.signal.aborted) setSaving(false); }
  }
  return <form className="project-tasks__detail form-stack" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h2>{task.title}</h2><p>{task.project_id ? <Link to={`/projects/${encodeURIComponent(task.project_id)}`}>{project?.name ?? task.project_name ?? '프로젝트 보기'}</Link> : '프로젝트 미배정'}</p>
    {task.description && <p>{task.description}</p>}
    <label>제목<input required maxLength={300} disabled={disabled || saving} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>상태<select value={status} disabled={disabled || saving} onChange={event => setStatus(event.target.value)}>{!taskStatuses.some(item => item.value === status) && <option value={status}>{statusLabel(status)}</option>}{taskStatuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    {disabled ? <div>담당자 <span data-assignee-display>{task.assignee_name ?? (task.assignee_id ? '담당자 정보 없음' : '미지정')}</span></div>
      : <AssigneeSelect session={session} taskId={task.id} value={assignee} onChange={setAssignee} disabled={saving || version.state === 'loading'} onAvailabilityChange={setAvailable} revision={version.refreshCount} showAccessWarning={administrator} />}
    <label>기한<input type="date" value={due} disabled={disabled || saving} onChange={event => setDue(event.target.value)} /></label>
    <progress aria-label={`${task.title} 진행률`} max={100} value={task.status === 'done' ? 100 : 0} />
    {(version.state === 'stale' || version.state === 'loading') && <div data-assignment-conflict role="alert"><p>업무가 변경되었습니다. 입력은 보존했습니다. 최신 업무를 불러와 다시 확인하세요.</p><Button type="button" tone="neutral" disabled={version.state === 'loading'} onClick={() => { setAvailable(false); void version.refresh(); }}>최신 업무 불러오기</Button></div>}
    {version.state === 'refreshed' && <p data-latest-task-version={version.latest?.version} role="status">최신 업무: {version.latest?.title} · {statusLabel(version.latest?.status ?? '')} · 기한 {version.latest?.due_at?.slice(0, 10) ?? '미정'} · 담당자 {version.latest?.assignee_name ?? version.latest?.assignee_id ?? '미지정'} · 버전 {version.latest?.version}. 보존한 입력으로 저장할지 확인하세요.</p>}
    {version.error && <p role="alert" className="field-error">{version.error}</p>}
    <Button type="submit" disabled={locked}>{version.state === 'refreshed' ? '확인 후 변경 저장' : '변경 저장'}</Button>
  </form>;
}
