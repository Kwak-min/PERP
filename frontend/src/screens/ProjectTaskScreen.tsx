import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { z } from "zod";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, ApiError, userMessageOf, type ApiSession } from "../services/api";
import { isPgWorkspace } from "../services/workspace";
import { useSession } from "../store/session";
import { useBranch } from "../store/branch";
import { useAccess } from '../hooks/useWorkspaceAccess';
import { useModalFocus } from '../hooks/useModalFocus';
import { StateBoundary } from "../components/common/StateBoundary";
import { Button } from "../components/ui/Button";
import { ProjectFinancePanel } from './projects/ProjectFinancePanel';
import { TaskDetail } from './projects/TaskDetail';
import { ProjectTaskCreateModal } from "./projects/ProjectTaskCreateModal";
import { ProjectAssignmentModal, type AssignmentResult, type ProjectAssignmentTarget } from './projects/ProjectAssignmentModal';
import { matchesProjectSearch, matchesTaskSearch, parseProjects, parseTasks, projectProgress, statusLabel, tasksForProject, taskStatuses, type Project, type Task } from "./projects/model";
import "./projects/project-tasks.css";

const permissionsSchema = z.object({ permissions: z.array(z.string()) });
const workspacesSchema = z.object({ organizations: z.array(permissionsSchema.extend({ org_id: z.string() })) });
type LoadState<T> = { status: "loading" | "ready" | "forbidden" | "error"; items: T[]; error: Error | null };

function useRows<T>(endpoint: string, session: ApiSession, revision: number, parse: (payload: unknown) => T[]): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading", items: [], error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", items: [], error: null });
    apiRequest(endpoint, { session, signal: controller.signal }).then(payload => {
      const items = parse(payload);
      if (!controller.signal.aborted) setState({ status: "ready", items, error: null });
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setState({ status: caught instanceof ApiError && caught.status === 403 ? "forbidden" : "error", items: [], error: caught instanceof Error ? caught : new Error("데이터 조회 실패") });
    });
    return () => controller.abort();
  }, [endpoint, session, revision, parse]);
  return state;
}

export function ProjectTaskScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo<ApiSession | null>(() => stored ? { token: stored.token, orgId: stored.orgId } : null, [stored]);
  return session ? <ProjectTaskWorkspace key={`${session.token}:${session.orgId}:${screen.id}`} screen={screen} session={session} /> : null;
}

function ProjectTaskWorkspace({ screen, session }: Readonly<{ screen: ScreenDefinition; session: ApiSession }>) {
  const { projectId, taskId } = useParams();
  const pg = isPgWorkspace(session.orgId);
  const branch = useBranch(session.orgId);
  const projectView = screen.id === "PRJ-001" || screen.id === "PRJ-002";
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => {
      // 파일 선택 창에서 돌아온 focus가 작성 중인 재무 폼을 없애지 않는다. 권한 변경은 계속 갱신한다.
      if (event.type === 'focus' && document.querySelector('[data-project-money] form')) return;
      setRevision(value => value + 1);
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('orbitflow:access-changed', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('orbitflow:access-changed', refresh); };
  }, []);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(projectId ? [projectId] : []));
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  function setQuery(value: string): void {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('q', value); else next.delete('q');
    setSearchParams(next, { replace: true });
  }
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [memberResult, setMemberResult] = useState<AssignmentResult | null>(null);
  const [modal, setModal] = useState<{ kind: "project" | "task"; projectId?: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [finishingProject, setFinishingProject] = useState<Project | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<ProjectAssignmentTarget | null>(null);
  const parseProjectRows = useMemo(() => (payload: unknown) => parseProjects(payload, pg), [pg]);
  const parseTaskRows = useMemo(() => (payload: unknown) => parseTasks(taskId && !pg ? { items: [payload] } : payload, pg), [pg, taskId]);
  const projects = useRows(`${pg ? "/pg" : ""}/projects?limit=-1${projectView && branch && !pg ? `&department_id=${encodeURIComponent(branch)}` : ""}`, session, revision, parseProjectRows);
  const tasks = useRows(taskId ? (pg ? `/pg/tasks?task_id=${encodeURIComponent(taskId)}` : `/tasks/${encodeURIComponent(taskId)}`) : `${pg ? "/pg" : ""}/tasks?limit=-1`, session, revision, parseTaskRows);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest(pg ? "/pg/auth/workspace" : "/tenants/current", { session, signal: controller.signal }).then(payload => {
      const grants = pg ? workspacesSchema.parse(payload).organizations.find(org => org.org_id === session.orgId)?.permissions ?? [] : permissionsSchema.parse(payload).permissions;
      if (!controller.signal.aborted) setPermissions(grants);
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setNotice(`작업 권한을 확인하지 못했습니다: ${userMessageOf(caught)}`); });
    return () => controller.abort();
  }, [pg, session, revision]);
  const can = (permission: string) => permissions.includes(permission) || (!pg && permissions.includes("*"));
  const administrator = useAccess()?.is_company_administrator === true;
  const refresh = () => setRevision(value => value + 1);
  async function updateTask(task: Task, patch: { status: string; title?: string; due_at?: string; assignee_id?: string | null }): Promise<void> {
    setSaving(task.id); setNotice(null);
    try {
      await apiRequest(`${pg ? '/pg' : ''}/tasks/${encodeURIComponent(task.id)}`, { session, method: "PATCH", body: pg
        ? { version: task.version, status: patch.status, ...(patch.assignee_id !== undefined ? { assignee_id: patch.assignee_id } : {}), ...(patch.title !== undefined ? { title: patch.title, due_on: patch.due_at || null } : {}) }
        : { ...patch, version: task.version } });
      refresh(); setNotice("업무를 저장했습니다.");
    } catch (caught: unknown) { setNotice(userMessageOf(caught)); }
    finally { setSaving(null); }
  }
  function toggle(id: string): void { setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function finishProject(): Promise<void> {
    if (!finishingProject || saving) return;
    setSaving(finishingProject.id); setFinishError(null);
    try {
      await apiRequest(`${pg ? '/pg' : ''}/projects/${encodeURIComponent(finishingProject.id)}`, { session, method: 'PATCH', body: { version: finishingProject.version, status: 'done' } });
      setFinishingProject(null); refresh(); setNotice('프로젝트를 완료했습니다. 업무와 재무 기록은 그대로 유지됩니다.');
    } catch (caught: unknown) { setFinishError(userMessageOf(caught)); }
    finally { setSaving(null); }
  }
  const filteredProjects = projects.items.filter(project => (!projectId || project.id === projectId) && matchesProjectSearch(project, query));
  const filteredTasks = tasks.items.filter(task => matchesTaskSearch(task, query, projects.items.find(project => project.id === task.project_id)));
  const detail = tasks.items[0];
  function taskList(items: readonly Task[]): React.ReactNode {
    return items.length ? <ul className="project-tasks__list">{items.map(task => <li key={task.id} data-task-id={task.id}>
      <div className="project-tasks__task-name"><Link to={`/tasks/${encodeURIComponent(task.id)}`}>{task.title}</Link>
        {!projectView && <small>{task.project_id ? <Link to={`/projects/${encodeURIComponent(task.project_id)}`}>{projects.items.find(project => project.id === task.project_id)?.name ?? task.project_name ?? "프로젝트 보기"}</Link> : "프로젝트 미배정"}</small>}
        <small>{task.assignee_name ?? task.assignee_id ?? "담당 미지정"}{task.due_at ? ` · ${task.due_at.slice(0, 10)}` : ""}</small></div>
      <div className="project-tasks__task-state"><progress aria-label={`${task.title} 진행률`} max={100} value={task.status === "done" ? 100 : 0} />
        <select aria-label={`${task.title} 상태`} disabled={!can("task.write") || saving !== null} value={task.status} onChange={event => void updateTask(task, { status: event.target.value })}>
          {!taskStatuses.some(item => item.value === task.status) && <option value={task.status}>{statusLabel(task.status)}</option>}
          {taskStatuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select><Button size="small" tone="neutral" disabled={!can('task.write') || saving !== null || task.version === undefined} onClick={() => setAssignmentTarget({ mode: 'assignment', task })}>담당자 배정</Button></div>
    </li>)}</ul> : <p className="project-tasks__empty" role="status">등록된 업무가 없습니다.</p>;
  }
  return <div className="screen project-tasks" data-screen-id={screen.id}>
    <header className="screen-header"><div><h1>{taskId ? "업무 상세" : projectView ? "프로젝트" : "전체 업무"}</h1><p>실제 프로젝트에 연결된 업무와 완료 현황을 확인합니다.</p></div>
      <div className="screen-header__actions"><Link className="button button--neutral" to={projectView ? "/tasks" : "/projects"}>{projectView ? "전체 업무" : "프로젝트로"}</Link>
        <Button tone="neutral" onClick={refresh}>새로고침</Button>
        {!taskId && <Button disabled={projectView ? !can("project.write") : !can("task.write") || projects.status !== "ready" || projects.items.length === 0} onClick={() => setModal({ kind: projectView ? "project" : "task" })}>{projectView ? "프로젝트 만들기" : "업무 만들기"}</Button>}</div></header>
    {notice && <div className="screen-notice" role="status" data-member-result={memberResult}><span>{notice}</span><Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button></div>}
    {!taskId && <label className="project-tasks__search">{projectView ? "프로젝트 검색" : "업무 검색"}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    {projectView ? <StateBoundary status={projects.status} error={projects.error}>
      {!filteredProjects.length && <p className="project-tasks__empty" role="status">{projectId ? "프로젝트를 찾을 수 없습니다." : query ? "검색 결과가 없습니다." : "등록된 프로젝트가 없습니다."}</p>}
      {filteredProjects.map(project => {
        const related = tasksForProject(tasks.items, project.id), progress = projectProgress(related), open = expanded.has(project.id);
        return <section key={project.id} className="project-tasks__project" data-project-id={project.id}>
          <div className="project-tasks__project-row"><button className="project-tasks__expand" aria-expanded={open} aria-controls={`project-tasks-${project.id}`} onClick={() => toggle(project.id)}><span aria-hidden="true">{open ? "−" : "+"}</span><strong>{project.name}</strong></button>
            <span data-project-status={project.status}>{project.status === 'done' ? '완료' : project.status === 'active' ? '진행 중' : project.status}</span>
            {tasks.status === "ready" ? <div className="project-tasks__progress"><progress aria-label={`${project.name} 진행률`} max={100} value={progress.percent} /><span>{progress.total ? `${progress.completed}/${progress.total} 완료 · ${progress.percent}%` : "업무 없음 · 0/0"}</span></div>
              : <span role="status">{tasks.status === "loading" ? "진행률 불러오는 중" : tasks.status === "forbidden" ? "업무 조회 권한 없음" : "진행률 조회 실패"}</span>}
          </div>
          <div id={`project-tasks-${project.id}`} hidden={!open} className="project-tasks__expanded">
            <div className="project-tasks__project-meta"><span>{project.start_date?.slice(0, 10) ?? "시작 미정"} ~ {project.end_date?.slice(0, 10) ?? "종료 미정"}</span><Button size="small" tone="neutral" disabled={!can('project.write')} onClick={() => setAssignmentTarget({ mode: 'member', project })}>구성원 추가</Button><Button size="small" disabled={!can('project.write') || project.version === undefined} onClick={() => setEditingProject(project)}>프로젝트 수정</Button><Button size="small" disabled={!can("task.write")} onClick={() => setModal({ kind: "task", projectId: project.id })}>업무 만들기</Button></div>
            <Button size="small" tone="neutral" disabled={!can('project.write') || project.version === undefined || project.status === 'done' || saving !== null} onClick={() => { setFinishError(null); setFinishingProject(project); }}>프로젝트 완료</Button>
            {open && <ProjectFinancePanel key={`money:${project.id}:${revision}`} projectId={project.id} projectName={project.name} session={session} />}
            {open && <ProjectRoster key={`${project.id}:${revision}`} projectId={project.id} session={session} />}
            <StateBoundary status={tasks.status} error={tasks.error}>{taskList(related)}</StateBoundary>
          </div>
        </section>;
      })}
    </StateBoundary> : <StateBoundary status={tasks.status} error={tasks.error}>{taskId ? detail
      ? <TaskDetail key={`${detail.id}:${revision}`} task={detail} session={session} project={projects.items.find(project => project.id === detail.project_id)} disabled={!can("task.write") || saving !== null} administrator={administrator} onSaved={() => { refresh(); setNotice('업무를 저장했습니다.'); }} />
      : <p role="status">업무를 찾을 수 없습니다.</p> : taskList(filteredTasks)}</StateBoundary>}
    {assignmentTarget && <ProjectAssignmentModal target={assignmentTarget} session={session} administrator={administrator} onClose={() => setAssignmentTarget(null)} onSaved={result => { refresh(); setMemberResult(result); setNotice(result === 'existing' ? '이미 소속된 구성원입니다. 현재 명단을 다시 확인했습니다.' : result === 'created' ? '프로젝트 구성원을 추가했습니다.' : '업무 배정을 저장했습니다.'); }} />}
    {editingProject && <ProjectTaskCreateModal kind="project" projects={projects.items} initialProject={editingProject} departmentId={null} session={session} onClose={() => setEditingProject(null)} onSaved={() => { setEditingProject(null); refresh(); setNotice('프로젝트를 저장했습니다.'); }} />}
    {finishingProject && <ProjectFinishDialog project={finishingProject} saving={saving !== null} error={finishError} onClose={() => setFinishingProject(null)} onConfirm={() => void finishProject()} />}
    {modal && <ProjectTaskCreateModal {...modal} canAddProjectMember={can('project.write')} projects={projects.items} departmentId={pg ? null : branch} session={session} onClose={() => setModal(null)} onSaved={() => { const id = modal.projectId; if (id) setExpanded(current => new Set([...current, id])); setModal(null); refresh(); setNotice("서버에 저장했습니다."); }} />}
  </div>;
}

const rosterSchema = z.object({ items: z.array(z.object({ value: z.string(), label: z.string() })) });
const parseRoster = (payload: unknown) => rosterSchema.parse(payload).items;
function ProjectRoster({ projectId, session }: Readonly<{ projectId: string; session: ApiSession }>) {
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const roster = useRows(`${isPgWorkspace(session.orgId) ? '/pg' : ''}/projects/${encodeURIComponent(projectId)}/members`, session, revision, parseRoster);
  const filtered = roster.items.filter(member => member.label.normalize('NFKC').toLocaleLowerCase().includes(query.trim().normalize('NFKC').toLocaleLowerCase()));
  return <section data-project-roster aria-label="프로젝트 구성원">
    <h3>프로젝트 구성원{roster.status === 'ready' ? ` (${roster.items.length})` : ''}</h3>
    <label>프로젝트 구성원 검색<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {roster.status === 'ready' ? filtered.length ? <ul>{filtered.map(member => <li key={member.value} data-member-id={member.value}>{member.label}</li>)}</ul> : <p role="status">{query ? '검색 결과가 없습니다.' : '등록된 구성원이 없습니다.'}</p>
      : roster.status === 'loading' ? <p role="status">구성원을 불러오는 중입니다.</p> : <p role="alert">구성원 명단: {userMessageOf(roster.error)}</p>}
    <Button type="button" size="small" tone="neutral" disabled={roster.status === 'loading'} onClick={() => setRevision(value => value + 1)}>명단 다시 불러오기</Button>
  </section>;
}

function ProjectFinishDialog({ project, saving, error, onClose, onConfirm }: Readonly<{ project: Project; saving: boolean; error: string | null; onClose: () => void; onConfirm: () => void }>) {
  const close = () => { if (!saving) onClose(); };
  const ref = useModalFocus<HTMLDivElement>(close, true);
  return <div className="modal-scrim" role="presentation" onMouseDown={close}><div ref={ref} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-finish-title" onMouseDown={event => event.stopPropagation()}>
    <header className="modal__head"><h2 id="project-finish-title">프로젝트 완료 확인</h2></header>
    <p>{project.name} 프로젝트를 완료 처리합니다. 미완료 업무를 포함한 모든 업무, 구성원 및 재무 기록은 그대로 유지됩니다.</p>
    {error && <p role="alert" className="field-error">{error} 창을 닫고 프로젝트를 새로고침한 뒤 현재 상태를 확인하세요.</p>}
    <footer className="modal__foot"><Button tone="neutral" disabled={saving} onClick={close}>닫기</Button><Button disabled={saving || Boolean(error)} onClick={onConfirm}>{saving ? '저장 중' : '완료 처리'}</Button></footer>
  </div></div>;
}
