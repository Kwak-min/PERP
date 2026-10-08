import { useState } from 'react';
import { z } from 'zod';
import { useModalFocus } from '../../hooks/useModalFocus';
import { apiRequest, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { AssigneeSelect } from '../../components/common/AssigneeSelect';
import { Button } from '../../components/ui/Button';
import { useTaskVersion } from './useTaskVersion';
import type { Project, Task } from './model';

const memberResultSchema = z.object({ created: z.boolean() });
export type ProjectAssignmentTarget = Readonly<{ mode: 'member'; project: Project }> | Readonly<{ mode: 'assignment'; task: Task }>;
export type AssignmentResult = 'created' | 'existing' | 'assigned';
export function ProjectAssignmentModal({ target, session, onClose, onSaved, administrator }: Readonly<{
  target: ProjectAssignmentTarget; session: ApiSession; onClose: () => void; onSaved: (result: AssignmentResult) => void; administrator: boolean;
}>) {
  const [selected, setSelected] = useState(target.mode === 'assignment' ? target.task.assignee_id ?? '' : '');
  const [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false), [available, setAvailable] = useState(false);
  const version = useTaskVersion(target.mode === 'assignment' ? target.task : null, session);
  const locked = saving || !available || (target.mode === 'member' ? !selected : !version.writable);
  const close = () => { if (!saving && (!dirty || window.confirm('입력한 내용이 사라집니다. 닫을까요?'))) onClose(); };
  const ref = useModalFocus<HTMLFormElement>(close, true);
  async function submit(): Promise<void> {
    if (locked) return;
    setSaving(true);
    const prefix = isPgWorkspace(session.orgId) ? '/pg' : '';
    try {
      let result: AssignmentResult;
      if (target.mode === 'member') {
        const payload = await apiRequest(`${prefix}/projects/${encodeURIComponent(target.project.id)}/members`, { method: 'POST', session, signal: version.signal, body: { user_id: selected } });
        result = memberResultSchema.parse(payload).created ? 'created' : 'existing';
      } else {
        await apiRequest(`${prefix}/tasks/${encodeURIComponent(target.task.id)}`, { method: 'PATCH', session, signal: version.signal, body: { version: version.latest?.version, assignee_id: selected || null } });
        result = 'assigned';
      }
      if (!version.signal.aborted) { onSaved(result); onClose(); }
    } catch (caught: unknown) { version.fail(caught); }
    finally { if (!version.signal.aborted) setSaving(false); }
  }
  return <div className="modal-scrim" role="presentation" onMouseDown={close}><form ref={ref} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-assignment-title" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <header className="modal__head"><h2 id="project-assignment-title">{target.mode === 'member' ? '프로젝트 구성원 추가' : '업무 담당자 배정'}</h2><Button type="button" tone="neutral" disabled={saving} onClick={close}>닫기</Button></header>
    <div className="form-stack"><strong>{target.mode === 'member' ? target.project.name : version.latest?.title}</strong>
      <p>{target.mode === 'member' ? '선택한 회사의 활성 구성원을 프로젝트에 추가합니다.' : '프로젝트 구성원에게 업무를 배정합니다. 같은 담당자로 저장하면 알림을 중복 발송하지 않습니다.'}</p>
      <AssigneeSelect session={session} value={selected} onChange={value => { setSelected(value); setDirty(true); }} disabled={saving || version.state === 'loading'} onAvailabilityChange={setAvailable}
        showAccessWarning={administrator && target.mode === 'assignment'} revision={version.refreshCount}
        label={target.mode === 'member' ? '추가할 구성원' : '담당자'} {...(target.mode === 'assignment' ? { taskId: target.task.id } : { candidateProjectId: target.project.id })} />
      {(version.state === 'stale' || version.state === 'loading') && <div data-assignment-conflict role="alert"><p>업무가 변경되었습니다. 선택은 보존했습니다. 최신 업무를 불러온 뒤 다시 확인하고 저장하세요.</p><Button type="button" tone="neutral" disabled={version.state === 'loading'} onClick={() => { setAvailable(false); void version.refresh(); }}>최신 업무 불러오기</Button></div>}
      {version.state === 'refreshed' && <p data-latest-task-version={version.latest?.version} role="status">최신 업무: {version.latest?.title} · 버전 {version.latest?.version} · 현재 담당자 {version.latest?.assignee_name ?? version.latest?.assignee_id ?? '미지정'}. 선택한 배정으로 저장할지 확인하세요.</p>}
    </div>{version.error && <p className="field-error" role="alert">{version.error}</p>}
    <footer className="modal__foot"><Button type="button" tone="neutral" disabled={saving} onClick={close}>취소</Button><Button type="submit" disabled={locked}>{saving ? '저장 중' : target.mode === 'member' ? '추가' : version.state === 'refreshed' ? '확인 후 배정 저장' : '배정 저장'}</Button></footer>
  </form></div>;
}
