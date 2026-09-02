import { useEffect, useState } from "react";

import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { useDepartments } from "../hooks/useDepartments";
import { Button } from "../components/ui/Button";

const AVAILABLE = [
  ["welcome", "환영"],
  ["tasks", "내 업무"],
  ["projects", "프로젝트"],
  ["calendar", "일정"],
  ["members", "구성원"],
  ["documents", "문서"],
] as const;

export function HomeBuilderScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const departments = useDepartments(session);
  const [departmentId, setDepartmentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [blocks, setBlocks] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = session?.organizations.find((org) => org.org_id === session.orgId)?.roles.some(
    (role) => role === "owner" || role === "org_admin",
  ) ?? false;

  useEffect(() => {
    if (!session) return;
    const params = new URLSearchParams();
    if (departmentId) params.set("department_id", departmentId);
    if (projectId) params.set("project_id", projectId);
    apiRequest(`/members/home-layout?${params}`, { session })
      .then((payload) => setBlocks((payload as { blocks: readonly string[] }).blocks))
      .catch((caught: unknown) => setMessage(userMessageOf(caught)));
  }, [departmentId, projectId, session]);

  async function save(): Promise<void> {
    if (!session) return;
    await apiRequest("/members/home-layout", {
      session, method: "PUT", body: {
        department_id: departmentId || null,
        project_id: projectId || null,
        blocks,
      },
    });
    setMessage("홈 구성을 저장했습니다.");
    setEditing(false);
  }

  return <main className="screen">
    <header className="screen-header"><div><span className="eyebrow">{screen.module}</span><h1>{screen.label}</h1><p>조직·부서·프로젝트별로 필요한 블록을 구성합니다.</p></div>{canEdit && <Button onClick={() => setEditing((value) => !value)}>홈 편집</Button>}</header>
    <div className="filter-bar">
      <label>관리 범위<select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">조직 전체</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name} 부서</option>)}</select></label>
      <label>프로젝트 ID<input value={projectId} placeholder="선택 입력" onChange={(event) => setProjectId(event.target.value)} /></label>
    </div>
    {message && <div className="screen-notice" role="status">{message}</div>}
    {editing && <section className="section-card"><h2>표시할 블록</h2><div className="note-editor__toggles">{AVAILABLE.map(([id, label]) => <label key={id}><input type="checkbox" checked={blocks.includes(id)} onChange={(event) => setBlocks((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} />{label}</label>)}</div><Button onClick={() => void save()}>구성 저장</Button></section>}
    <div className="dashboard-blocks">{blocks.map((id) => <section className="section-card" key={id} data-block={id}><h2>{AVAILABLE.find(([value]) => value === id)?.[1] ?? id}</h2><p>{departmentId ? `${departments.find((item) => item.id === departmentId)?.name} 부서` : "조직 전체"}{projectId ? ` · 프로젝트 ${projectId}` : ""} 범위의 데이터입니다.</p></section>)}</div>
  </main>;
}
