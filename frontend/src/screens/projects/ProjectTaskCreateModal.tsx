import { useRef, useState } from "react";
import { useModalFocus } from "../../hooks/useModalFocus";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { Button } from "../../components/ui/Button";
import type { Project } from "./model";

export function ProjectTaskCreateModal({ kind, projects, projectId, departmentId, session, onClose, onSaved, initialProject }: Readonly<{
  kind: "project" | "task"; projects: readonly Project[]; projectId?: string; departmentId: string | null; initialProject?: Project;
  session: ApiSession; onClose: () => void; onSaved: () => void;
}>) {
  const first = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialProject?.name ?? "");
  const [project, setProject] = useState(projectId ?? "");
  const [start, setStart] = useState(initialProject?.start_date?.slice(0, 10) ?? "");
  const [end, setEnd] = useState(initialProject?.end_date?.slice(0, 10) ?? "");
  const [description, setDescription] = useState(initialProject?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!saving) onClose(); };
  const ref = useModalFocus<HTMLFormElement>(close, true, first);
  async function submit(): Promise<void> {
    if (!name.trim() || (kind === "task" && !project)) { setError("이름과 프로젝트를 확인해 주세요."); return; }
    if (kind === "project" && start && end && end < start) { setError("종료일은 시작일보다 빠를 수 없습니다."); return; }
    setSaving(true); setError(null);
    const pg = isPgWorkspace(session.orgId);
    try {
      await apiRequest(`${pg ? "/pg" : ""}/${kind === "project" ? "projects" : "tasks"}${initialProject ? `/${encodeURIComponent(initialProject.id)}` : ""}`, { session, method: initialProject ? "PATCH" : "POST", body: kind === "project"
        ? { ...(initialProject ? { version: initialProject.version } : {}), name: name.trim(), description, ...(pg ? { starts_on: start || null, ends_on: end || null } : { start_date: start || null, end_date: end || null, department_id: departmentId }) }
        : { title: name.trim(), project_id: project, ...(pg ? { due_on: end || null } : { due_at: end || null }) } });
      onSaved();
    } catch (caught: unknown) { setError(userMessageOf(caught)); setSaving(false); }
  }
  return <div className="modal-scrim" role="presentation" onMouseDown={close}>
    <form ref={ref} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-task-create-title" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header className="modal__head"><h2 id="project-task-create-title">{initialProject ? "프로젝트 수정" : kind === "project" ? "프로젝트 만들기" : "업무 만들기"}</h2><Button tone="neutral" disabled={saving} onClick={close}>닫기</Button></header>
      <div className="form-stack">
        <label>{kind === "project" ? "이름" : "제목"}<input ref={first} required maxLength={kind === "project" ? 200 : 300} value={name} onChange={event => setName(event.target.value)} /></label>
        {kind === "task" && <label>프로젝트<select required disabled={Boolean(projectId)} value={project} onChange={event => setProject(event.target.value)}><option value="">프로젝트 선택</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {kind === "project" && <><label>시작<input type="date" value={start} onChange={event => setStart(event.target.value)} /></label><label>설명<textarea value={description} onChange={event => setDescription(event.target.value)} /></label></>}
        <label>{kind === "project" ? "종료" : "기한"}<input type="date" value={end} onChange={event => setEnd(event.target.value)} /></label>
      </div>
      {error && <p role="alert" className="field-error">{error}</p>}
      <footer className="modal__foot"><Button tone="neutral" disabled={saving} onClick={close}>취소</Button><Button type="submit" disabled={saving}>{saving ? "저장 중" : initialProject ? "저장" : "만들기"}</Button></footer>
    </form>
  </div>;
}
