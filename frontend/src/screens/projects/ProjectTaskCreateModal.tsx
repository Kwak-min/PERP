import { useRef, useState } from "react";
import { z } from 'zod';
import { sessionStore } from '../../store/session';
import { useModalFocus } from "../../hooks/useModalFocus";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { createRequestKey } from '../../services/requestKey';
import { Button } from "../../components/ui/Button";
import { AssigneeSelect } from '../../components/common/AssigneeSelect';
import type { Project } from "./model";
import { matchesProjectSearch } from './model';

const taskAttemptSchema = z.object({ key: z.string().uuid(), member_ids: z.array(z.string()).default([]), provision_members: z.boolean().default(false), body: z.object({
  title: z.string(), project_id: z.string(), assignee_id: z.string().nullable(),
  due_on: z.string().nullable().optional(), due_at: z.string().nullable().optional(),
}).strict() });
type TaskAttempt = z.infer<typeof taskAttemptSchema>;
const taskCreatedSchema = z.object({ id: z.string().min(1), version: z.number().int().positive() });

export function ProjectTaskCreateModal({ kind, projects, projectId, departmentId, session, onClose, onSaved, initialProject, canAddProjectMember = false }: Readonly<{
  kind: "project" | "task"; projects: readonly Project[]; projectId?: string; departmentId: string | null; initialProject?: Project;
  session: ApiSession; onClose: () => void; onSaved: () => void; canAddProjectMember?: boolean;
}>) {
  const first = useRef<HTMLInputElement>(null);
  // 같은 탭에서 닫기/새로고침 후에도 미확인 작업은 새 요청으로 바꾸지 않는다.
  const attemptStorageKey = `orbitflow.task-create.v1:${JSON.stringify([session.orgId, sessionStore.getSnapshot()?.email])}`;
  const [attempt, setAttempt] = useState<TaskAttempt | null>(() => {
    const stored = kind === 'task' ? sessionStorage.getItem(attemptStorageKey) : null;
    return stored ? taskAttemptSchema.parse(JSON.parse(stored)) : null;
  });
  const [name, setName] = useState(attempt?.body.title ?? initialProject?.name ?? "");
  const [project, setProject] = useState(attempt?.body.project_id ?? projectId ?? "");
  const [assignee, setAssignee] = useState(attempt?.body.assignee_id ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(attempt?.member_ids ?? []);
  const [projectQuery, setProjectQuery] = useState('');
  const [available, setAvailable] = useState(false);
  const [start, setStart] = useState(initialProject?.start_date?.slice(0, 10) ?? "");
  const [end, setEnd] = useState(attempt?.body.due_on ?? attempt?.body.due_at ?? initialProject?.end_date?.slice(0, 10) ?? "");
  const [description, setDescription] = useState(initialProject?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftLocked = saving || attempt !== null;
  const close = () => { if (!saving) onClose(); };
  const ref = useModalFocus<HTMLFormElement>(close, true, first);
  async function submit(): Promise<void> {
    if (saving || (kind === 'task' && !attempt && !available)) return;
    if (!name.trim() || (kind === "task" && !project)) { setError("이름과 프로젝트를 확인해 주세요."); return; }
    if (kind === "project" && start && end && end < start) { setError("종료일은 시작일보다 빠를 수 없습니다."); return; }
    setSaving(true); setError(null);
    const pg = isPgWorkspace(session.orgId);
    let membershipConfirmed = false;
    try {
      if (kind === 'task') {
        const operation = attempt ?? { key: createRequestKey(), member_ids: memberIds, provision_members: canAddProjectMember, body: { title: name.trim(), project_id: project, assignee_id: assignee || null, ...(pg ? { due_on: end || null } : { due_at: end || null }) } };
        // 소속 추가 전에도 원래 선택/payload/key를 보존한다. 부분 실패와 응답 유실 모두 같은 작업으로 재시도한다.
        sessionStorage.setItem(attemptStorageKey, JSON.stringify(operation)); setAttempt(operation);
        if (canAddProjectMember || operation.provision_members) {
          const members = new Set([...operation.member_ids, ...(operation.body.assignee_id ? [operation.body.assignee_id] : [])]);
          for (const userId of members) {
            await apiRequest(`${pg ? '/pg' : ''}/projects/${encodeURIComponent(operation.body.project_id)}/members`, { session, method: 'POST', body: { user_id: userId } });
            membershipConfirmed = true;
          }
        }
        // 성공 상태만으로 확정하지 않는다. 잘린 응답에도 원래 요청 키를 유지한다.
        taskCreatedSchema.parse(await apiRequest(`${pg ? '/pg' : ''}/tasks`, { session, method: 'POST', headers: { 'Idempotency-Key': operation.key }, body: operation.body }));
        sessionStorage.removeItem(attemptStorageKey); setAttempt(null);
      } else {
        await apiRequest(`${pg ? '/pg' : ''}/projects${initialProject ? `/${encodeURIComponent(initialProject.id)}` : ''}`, { session, method: initialProject ? 'PATCH' : 'POST', body:
          { ...(initialProject ? { version: initialProject.version } : {}), name: name.trim(), description, ...(pg ? { starts_on: start || null, ends_on: end || null } : { start_date: start || null, end_date: end || null, department_id: departmentId }) } });
      }
      onSaved();
    } catch (caught: unknown) {
      setError(`${membershipConfirmed ? '확인/추가된 프로젝트 소속은 유지됩니다. ' : ''}${caught instanceof z.ZodError ? '서버 응답을 확인하지 못했습니다. 원래 요청으로 저장 결과를 확인/재시도하세요.' : userMessageOf(caught)}`);
      setSaving(false);
    }
  }
  return <div className="modal-scrim" role="presentation" onMouseDown={close}>
    <form ref={ref} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-task-create-title" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header className="modal__head"><h2 id="project-task-create-title">{initialProject ? "프로젝트 수정" : kind === "project" ? "프로젝트 만들기" : "업무 만들기"}</h2><Button tone="neutral" disabled={saving} onClick={close}>닫기</Button></header>
      <div className="form-stack">
        <label>{kind === "project" ? "이름" : "제목"}<input ref={first} disabled={draftLocked} required maxLength={kind === "project" ? 200 : 300} value={name} onChange={event => setName(event.target.value)} /></label>
        {kind === 'task' && !projectId && <label>프로젝트 검색<input type="search" disabled={draftLocked} value={projectQuery} onChange={event => setProjectQuery(event.target.value)} /></label>}
        {kind === "task" && <label>프로젝트<select required disabled={Boolean(projectId) || draftLocked} value={project} onChange={event => { setAvailable(false); setProject(event.target.value); setAssignee(''); setMemberIds([]); }}><option value="">프로젝트 선택</option>{projects.filter(item => item.id === project || matchesProjectSearch(item, projectQuery)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {kind === 'task' && <AssigneeSelect session={session} projectId={project} value={assignee} onChange={setAssignee} onAvailabilityChange={setAvailable} disabled={draftLocked || !project} canAddProjectMember={canAddProjectMember} memberIds={memberIds} onMembersChange={setMemberIds} />}
        {kind === 'task' && (assignee || memberIds.length > 0) && canAddProjectMember && <p data-project-member-add-note role="note">선택한 구성원과 담당자를 프로젝트 구성원으로 확인/추가한 뒤 업무 하나를 저장합니다. 역할과 조회 권한은 자동 부여하지 않습니다. 업무 저장이 실패해도 추가된 프로젝트 소속은 유지됩니다.</p>}
        {kind === "project" && <><label>시작<input type="date" value={start} onChange={event => setStart(event.target.value)} /></label><label>설명<textarea value={description} onChange={event => setDescription(event.target.value)} /></label></>}
        <label>{kind === "project" ? "종료" : "기한"}<input type="date" disabled={draftLocked} value={end} onChange={event => setEnd(event.target.value)} /></label>
      </div>
      {attempt && <p data-task-create-pending role="status">업무 저장 결과를 확인해야 합니다. 원래 입력과 요청 키를 보관했습니다. 같은 요청으로 확인/재시도하면 이미 저장된 업무를 반환하며 중복 생성하지 않습니다. 결과 확인 전에는 입력을 바꿀 수 없고, 창을 다시 열어도 이 작업을 이어갑니다.</p>}
      {error && <p role="alert" className="field-error">{error}</p>}
      <footer className="modal__foot"><Button tone="neutral" disabled={saving} onClick={close}>취소</Button><Button type="submit" disabled={saving || (kind === 'task' && !attempt && !available)}>{saving ? "저장 중" : attempt ? '같은 요청 확인/재시도' : initialProject ? "저장" : "만들기"}</Button></footer>
    </form>
  </div>;
}
