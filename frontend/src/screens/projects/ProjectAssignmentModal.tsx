import { useState } from 'react';
import { useModalFocus } from '../../hooks/useModalFocus';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { AssigneeSelect } from '../../components/common/AssigneeSelect';
import { Button } from '../../components/ui/Button';
import type { Project, Task } from './model';

export type ProjectAssignmentTarget = Readonly<{ mode: 'member'; project: Project }> | Readonly<{ mode: 'assignment'; task: Task }>;
export function ProjectAssignmentModal({ target, session, onClose, onSaved }: Readonly<{
  target: ProjectAssignmentTarget; session: ApiSession; onClose: () => void; onSaved: () => void;
}>) {
  const [selected, setSelected] = useState(target.mode === 'assignment' ? target.task.assignee_id ?? '' : '');
  const [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState<string | null>(null);
  const close = () => { if (!saving && (!dirty || window.confirm('입력한 내용이 사라집니다. 닫을까요?'))) onClose(); };
  const ref = useModalFocus<HTMLFormElement>(close, true);
  async function submit(): Promise<void> {
    if (target.mode === 'member' && !selected) { setError('추가할 구성원을 선택하세요.'); return; }
    setSaving(true); setError(null);
    const prefix = isPgWorkspace(session.orgId) ? '/pg' : '';
    try {
      if (target.mode === 'member') await apiRequest(`${prefix}/projects/${encodeURIComponent(target.project.id)}/members`, { method: 'POST', session, body: { user_id: selected } });
      else await apiRequest(`${prefix}/tasks/${encodeURIComponent(target.task.id)}`, { method: 'PATCH', session, body: { version: target.task.version, assignee_id: selected || null } });
      onSaved(); onClose();
    } catch (caught: unknown) { setError(userMessageOf(caught)); setSaving(false); }
  }
  return <div className="modal-scrim" role="presentation" onMouseDown={close}><form ref={ref} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-assignment-title" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <header className="modal__head"><h2 id="project-assignment-title">{target.mode === 'member' ? '프로젝트 구성원 추가' : '업무 담당자 배정'}</h2><Button type="button" tone="neutral" disabled={saving} onClick={close}>닫기</Button></header>
    <div className="form-stack"><strong>{target.mode === 'member' ? target.project.name : target.task.title}</strong>
      <p>{target.mode === 'member' ? '현재 조직의 구성원을 프로젝트에 추가합니다.' : '프로젝트 구성원에게 업무를 배정하면 해당 구성원의 알림함에 전달됩니다.'}</p>
      <AssigneeSelect session={session} value={selected} onChange={value => { setSelected(value); setDirty(true); }} disabled={saving}
        label={target.mode === 'member' ? '추가할 구성원' : '담당자'} {...(target.mode === 'assignment' ? { projectId: target.task.project_id } : {})} />
    </div>{error && <p className="field-error" role="alert">{error}</p>}
    <footer className="modal__foot"><Button type="button" tone="neutral" disabled={saving} onClick={close}>취소</Button><Button type="submit" disabled={saving}>{saving ? '저장 중' : target.mode === 'member' ? '추가' : '배정 저장'}</Button></footer>
  </form></div>;
}
