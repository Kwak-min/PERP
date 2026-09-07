import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { z } from "zod";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, ApiError, userMessageOf, type ApiSession } from "../services/api";
import { isPgWorkspace } from "../services/workspace";
import { useSession } from "../store/session";
import { useBranch } from "../store/branch";
import { StateBoundary } from "../components/common/StateBoundary";
import { Button } from "../components/ui/Button";
import { ProjectTaskCreateModal } from "./projects/ProjectTaskCreateModal";
import { parseProjects, parseTasks, projectProgress, statusLabel, tasksForProject, taskStatuses, type Project, type Task } from "./projects/model";
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
  return session ? <ProjectTaskWorkspace key={`${session.orgId}:${screen.id}`} screen={screen} session={session} /> : null;
}

function ProjectTaskWorkspace({ screen, session }: Readonly<{ screen: ScreenDefinition; session: ApiSession }>) {
  const { projectId, taskId } = useParams();
  const pg = isPgWorkspace(session.orgId);
  const branch = useBranch(session.orgId);
  const projectView = screen.id === "PRJ-001" || screen.id === "PRJ-002";
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(projectId ? [projectId] : []));
  const [query, setQuery] = useState("");
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<{ kind: "project" | "task"; projectId?: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
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
  }, [pg, session]);
  const can = (permission: string) => permissions.includes(permission) || (!pg && permissions.includes("*"));
  const refresh = () => setRevision(value => value + 1);
  async function updateTask(task: Task, patch: { status: string; title?: string; due_at?: string }): Promise<void> {
    setSaving(task.id); setNotice(null);
    try {
      await apiRequest(pg ? `/pg/records/tasks/${encodeURIComponent(task.id)}` : `/tasks/${encodeURIComponent(task.id)}`, { session, method: "PATCH", body: pg
        ? { status: patch.status, ...(patch.title !== undefined ? { title: patch.title, due_on: patch.due_at || null } : {}) }
        : { ...patch, version: task.version } });
      refresh(); setNotice("업무를 저장했습니다.");
    } catch (caught: unknown) { setNotice(userMessageOf(caught)); }
    finally { setSaving(null); }
  }
  function toggle(id: string): void { setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  const filteredProjects = projects.items.filter(project => (!projectId || project.id === projectId) && project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const filteredTasks = tasks.items.filter(task => task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
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
        </select></div>
    </li>)}</ul> : <p className="project-tasks__empty" role="status">등록된 업무가 없습니다.</p>;
  }
  return <div className="screen project-tasks" data-screen-id={screen.id}>
    <header className="screen-header"><div><h1>{taskId ? "업무 상세" : projectView ? "프로젝트와 업무" : "전체 업무"}</h1><p>실제 프로젝트에 연결된 업무와 완료 현황을 확인합니다.</p></div>
      <div className="screen-header__actions"><Link className="button button--neutral" to={projectView ? "/tasks" : "/projects"}>{projectView ? "전체 업무" : "프로젝트로"}</Link>
        <Button tone="neutral" onClick={refresh}>새로고침</Button>
        {!taskId && <Button disabled={projectView ? !can("project.write") : !can("task.write") || projects.status !== "ready" || projects.items.length === 0} onClick={() => setModal({ kind: projectView ? "project" : "task" })}>{projectView ? "프로젝트 만들기" : "업무 만들기"}</Button>}</div></header>
    {notice && <div className="screen-notice" role="status"><span>{notice}</span><Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button></div>}
    {!taskId && <label className="project-tasks__search">{projectView ? "프로젝트 검색" : "업무 검색"}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    {projectView ? <StateBoundary status={projects.status} error={projects.error}>
      {!filteredProjects.length && <p className="project-tasks__empty" role="status">{projectId ? "프로젝트를 찾을 수 없습니다." : query ? "검색 결과가 없습니다." : "등록된 프로젝트가 없습니다."}</p>}
      {filteredProjects.map(project => {
        const related = tasksForProject(tasks.items, project.id), progress = projectProgress(related), open = expanded.has(project.id);
        return <section key={project.id} className="project-tasks__project" data-project-id={project.id}>
          <div className="project-tasks__project-row"><button className="project-tasks__expand" aria-expanded={open} aria-controls={`project-tasks-${project.id}`} onClick={() => toggle(project.id)}><span aria-hidden="true">{open ? "−" : "+"}</span><strong>{project.name}</strong></button>
            {tasks.status === "ready" ? <div className="project-tasks__progress"><progress aria-label={`${project.name} 진행률`} max={100} value={progress.percent} /><span>{progress.total ? `${progress.completed}/${progress.total} 완료 · ${progress.percent}%` : "업무 없음 · 0/0"}</span></div>
              : <span role="status">{tasks.status === "loading" ? "진행률 불러오는 중" : tasks.status === "forbidden" ? "업무 조회 권한 없음" : "진행률 조회 실패"}</span>}
          </div>
          <div id={`project-tasks-${project.id}`} hidden={!open} className="project-tasks__expanded">
            <div className="project-tasks__project-meta"><span>{project.start_date?.slice(0, 10) ?? "시작 미정"} ~ {project.end_date?.slice(0, 10) ?? "종료 미정"}</span><Button size="small" disabled={!can("task.write")} onClick={() => setModal({ kind: "task", projectId: project.id })}>업무 만들기</Button></div>
            <StateBoundary status={tasks.status} error={tasks.error}>{taskList(related)}</StateBoundary>
          </div>
        </section>;
      })}
    </StateBoundary> : <StateBoundary status={tasks.status} error={tasks.error}>{taskId ? detail
      ? <TaskDetail key={`${detail.id}:${revision}`} task={detail} project={projects.items.find(project => project.id === detail.project_id)} disabled={!can("task.write") || saving !== null} onSave={patch => void updateTask(detail, patch)} />
      : <p role="status">업무를 찾을 수 없습니다.</p> : taskList(filteredTasks)}</StateBoundary>}
    {modal && <ProjectTaskCreateModal {...modal} projects={projects.items} departmentId={pg ? null : branch} session={session} onClose={() => setModal(null)} onSaved={() => { const id = modal.projectId; if (id) setExpanded(current => new Set([...current, id])); setModal(null); refresh(); setNotice("서버에 저장했습니다."); }} />}
  </div>;
}

function TaskDetail({ task, project, disabled, onSave }: Readonly<{ task: Task; project: Project | undefined; disabled: boolean; onSave: (patch: { title: string; status: string; due_at: string }) => void }>) {
  const [title, setTitle] = useState(task.title), [status, setStatus] = useState(task.status), [due, setDue] = useState(task.due_at?.slice(0, 10) ?? "");
  return <form className="project-tasks__detail form-stack" onSubmit={event => { event.preventDefault(); if (title.trim()) onSave({ title: title.trim(), status, due_at: due }); }}>
    <h2>{task.title}</h2><p>{task.project_id ? <Link to={`/projects/${encodeURIComponent(task.project_id)}`}>{project?.name ?? task.project_name ?? "프로젝트 보기"}</Link> : "프로젝트 미배정"}</p>
    {task.description && <p>{task.description}</p>}
    <label>제목<input required maxLength={300} disabled={disabled} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>상태<select value={status} disabled={disabled} onChange={event => setStatus(event.target.value)}>{!taskStatuses.some(item => item.value === status) && <option value={status}>{statusLabel(status)}</option>}{taskStatuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    <label>기한<input type="date" value={due} disabled={disabled} onChange={event => setDue(event.target.value)} /></label>
    <progress aria-label={`${task.title} 진행률`} max={100} value={task.status === "done" ? 100 : 0} />
    <Button type="submit" disabled={disabled}>변경 저장</Button>
  </form>;
}
