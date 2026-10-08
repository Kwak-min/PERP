import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { DueLabel, Empty, PageHead, Pill } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Task = {
  id: string;
  title: string;
  project_id: string | null;
  assignee_id: string | null;
  status: string;
  priority: string;
  due_at: string | null;
  ai_generated?: boolean;
};
type Project = { id: string; name: string };
type Member = { user_id: string; name: string };

export const TASK_STATUS: Record<string, string> = {
  todo: "할 일",
  in_progress: "진행 중",
  review: "검토",
  done: "완료",
};
const TASK_TONE: Record<string, string> = {
  todo: "muted",
  in_progress: "info",
  review: "warn",
  done: "ok",
};
const PRIORITY_LABEL: Record<string, string> = { high: "높음", normal: "보통", low: "낮음" };
const PRIO_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

// TSK-001 업무 — 실제 백엔드(/tasks) 연동, 목업 디자인 유지
export function TasksScreen() {
  const [q, setQ] = useState("");
  const [proj, setProj] = useState("");
  const [who, setWho] = useState("");
  const [st, setSt] = useState("open");
  const [sort, setSort] = useState("due");

  const tasksRes = useApi<{ items: Task[] }>("/tasks");
  const projRes = useApi<{ items: Project[] }>("/projects");
  const memberRes = useApi<{ items: Member[] }>("/members");

  const projName = useMemo(() => {
    const m = new Map((projRes.data?.items ?? []).map((p) => [p.id, p.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "프로젝트 없음") : "프로젝트 없음");
  }, [projRes.data]);
  const memberName = useMemo(() => {
    const m = new Map((memberRes.data?.items ?? []).map((x) => [x.user_id, x.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "-") : "-");
  }, [memberRes.data]);

  const tasks = tasksRes.data?.items ?? [];
  const list = tasks
    .filter(
      (t) =>
        (!q || t.title.includes(q)) &&
        (!proj || t.project_id === proj) &&
        (!who || t.assignee_id === who) &&
        (st === "all" ? true : st === "open" ? t.status !== "done" : t.status === st),
    )
    .sort((a, b) =>
      sort === "prio"
        ? (PRIO_ORDER[a.priority] ?? 9) - (PRIO_ORDER[b.priority] ?? 9) ||
          (a.due_at ?? "").localeCompare(b.due_at ?? "")
        : sort === "title"
          ? a.title.localeCompare(b.title)
          : (a.due_at ?? "").localeCompare(b.due_at ?? ""),
    );

  return (
    <>
      <PageHead
        title="업무"
        id="TSK-001"
        fr="SFR-008"
        desc="정렬·필터·일괄 수정·저장된 보기를 지원합니다. 행을 누르면 상세가 열립니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="plus" />
            새 업무
          </button>
        }
      />
      <div className="filters">
        <input
          type="search"
          placeholder="업무 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="검색"
        />
        <select value={proj} onChange={(e) => setProj(e.target.value)} aria-label="프로젝트">
          <option value="">모든 프로젝트</option>
          {(projRes.data?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="담당자">
          <option value="">모든 담당자</option>
          {(memberRes.data?.items ?? []).map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.name}
            </option>
          ))}
        </select>
        <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태">
          <option value="open">미완료</option>
          {Object.entries(TASK_STATUS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
          <option value="all">전체</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="정렬">
          <option value="due">마감일순</option>
          <option value="prio">우선순위순</option>
          <option value="title">제목순</option>
        </select>
      </div>
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>업무</th>
              <th>프로젝트</th>
              <th>담당</th>
              <th>상태</th>
              <th>우선순위</th>
              <th>마감</th>
            </tr>
          </thead>
          <tbody>
            {tasksRes.loading ? (
              <tr>
                <td colSpan={6}>
                  <Empty title="불러오는 중…" icon="clock" />
                </td>
              </tr>
            ) : tasksRes.error ? (
              <tr>
                <td colSpan={6}>
                  <Empty title="업무를 불러오지 못했습니다" desc={tasksRes.error} icon="alert" />
                </td>
              </tr>
            ) : list.length ? (
              list.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link className="t-title" to={`/tasks/${t.id}`}>
                      {t.title}
                    </Link>
                    {t.ai_generated && <span className="pill ai"> AI 생성</span>}
                  </td>
                  <td className="muted">{projName(t.project_id)}</td>
                  <td className="nowrap">{memberName(t.assignee_id)}</td>
                  <td>
                    <Pill tone={TASK_TONE[t.status] ?? "muted"}>
                      {TASK_STATUS[t.status] ?? t.status}
                    </Pill>
                  </td>
                  <td>
                    <Pill tone={t.priority === "high" ? "bad" : "muted"}>
                      {PRIORITY_LABEL[t.priority] ?? t.priority}
                    </Pill>
                  </td>
                  <td className="nowrap">
                    {t.due_at ? (
                      <>
                        {fmtDue(t.due_at)} <DueLabel due={t.due_at} done={t.status === "done"} />
                      </>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6}>
                  <Empty title="조건에 맞는 업무가 없습니다" desc="필터를 바꿔 보세요." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        {list.length}건 · 서버에서 cursor pagination(limit 20)으로 불러옵니다.
      </p>
    </>
  );
}

function fmtDue(s: string): string {
  const wd = ["일", "월", "화", "수", "목", "금", "토"];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, "0")} (${wd[d.getDay()]})`;
}
