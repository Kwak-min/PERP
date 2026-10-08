import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { Av, Empty, Meter, PageHead, Pill, fmtDate, pct, won } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Project = {
  id: string;
  name: string;
  description: string;
  status: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  budget_amount: number;
};
type Task = { project_id: string | null; status: string };
type Member = { user_id: string; name: string };

const STATUS_LABEL: Record<string, string> = {
  active: "진행",
  planning: "계획",
  planned: "계획",
  completed: "완료",
  done: "완료",
  on_hold: "보류",
  archived: "보관",
};
const STATUS_TONE: Record<string, string> = {
  active: "info",
  planning: "muted",
  planned: "muted",
  completed: "ok",
  done: "ok",
  on_hold: "warn",
  archived: "muted",
};

// PRJ-001 프로젝트 — 실제 백엔드(/projects) 연동, 목업 디자인 유지
export function ProjectsScreen() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [view, setView] = useState<"card" | "list">("card");

  const projRes = useApi<{ items: Project[] }>("/projects");
  const taskRes = useApi<{ items: Task[] }>("/tasks");
  const memberRes = useApi<{ items: Member[] }>("/members");

  const progress = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const t of taskRes.data?.items ?? []) {
      if (!t.project_id) continue;
      const cur = map.get(t.project_id) ?? { done: 0, total: 0 };
      cur.total += 1;
      if (t.status === "done") cur.done += 1;
      map.set(t.project_id, cur);
    }
    return (id: string) => map.get(id) ?? { done: 0, total: 0 };
  }, [taskRes.data]);
  const ownerName = useMemo(() => {
    const m = new Map((memberRes.data?.items ?? []).map((x) => [x.user_id, x.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "-") : "-");
  }, [memberRes.data]);

  const projects = projRes.data?.items ?? [];
  const list = projects.filter(
    (p) => (!status || p.status === status) && (!q || p.name.includes(q)),
  );

  return (
    <>
      <PageHead
        title="프로젝트"
        id="PRJ-001"
        fr="SFR-007"
        desc="상태·기간·담당자로 조직의 프로젝트를 관리합니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="plus" />
            새 프로젝트
          </button>
        }
      />
      <div className="filters">
        <input
          type="search"
          placeholder="프로젝트 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="검색"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="상태">
          <option value="">모든 상태</option>
          <option value="active">진행</option>
          <option value="planning">계획</option>
          <option value="completed">완료</option>
          <option value="on_hold">보류</option>
        </select>
        <span className="grow" />
        <div className="seg">
          {(["card", "list"] as const).map((k) => (
            <button
              type="button"
              key={k}
              className={view === k ? "on" : ""}
              onClick={() => setView(k)}
            >
              {k === "card" ? "카드" : "목록"}
            </button>
          ))}
        </div>
      </div>

      {projRes.loading ? (
        <div className="panel">
          <Empty title="불러오는 중…" icon="clock" />
        </div>
      ) : projRes.error ? (
        <div className="panel">
          <Empty title="프로젝트를 불러오지 못했습니다" desc={projRes.error} icon="alert" />
        </div>
      ) : !list.length ? (
        <div className="panel">
          <Empty title="조건에 맞는 프로젝트가 없습니다" desc="새 프로젝트를 만드세요." />
        </div>
      ) : view === "card" ? (
        <div className="grid g3">
          {list.map((p) => {
            const pr = progress(p.id);
            const rate = pct(pr.done, pr.total);
            return (
              <Link
                className="panel"
                to={`/projects/${p.id}`}
                key={p.id}
                style={{ color: "inherit", display: "grid", gap: 10, padding: 16 }}
              >
                <div className="row between">
                  <Pill tone={STATUS_TONE[p.status] ?? "muted"}>
                    {STATUS_LABEL[p.status] ?? p.status}
                  </Pill>
                  <span className="muted xs">
                    {fmtDate(p.start_date ?? "")} – {fmtDate(p.end_date ?? "")}
                  </span>
                </div>
                <div>
                  <b style={{ fontSize: 15 }}>{p.name}</b>
                  <p className="muted sm" style={{ marginTop: 4 }}>
                    {p.description}
                  </p>
                </div>
                <div className="row between">
                  <span className="av-stack">
                    <Av name={ownerName(p.owner_id)} size="sm" />
                  </span>
                  <span className="xs muted">
                    업무 {pr.done}/{pr.total} · {rate}%
                  </span>
                </div>
                <Meter p={rate} />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="panel tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>프로젝트</th>
                <th>상태</th>
                <th>담당</th>
                <th>기간</th>
                <th>진행률</th>
                <th className="num">예산</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const pr = progress(p.id);
                const rate = pct(pr.done, pr.total);
                return (
                  <tr key={p.id}>
                    <td>
                      <Link className="t-title" to={`/projects/${p.id}`}>
                        {p.name}
                      </Link>
                    </td>
                    <td>
                      <Pill tone={STATUS_TONE[p.status] ?? "muted"}>
                        {STATUS_LABEL[p.status] ?? p.status}
                      </Pill>
                    </td>
                    <td>{ownerName(p.owner_id)}</td>
                    <td className="nowrap">
                      {fmtDate(p.start_date ?? "")} – {fmtDate(p.end_date ?? "")}
                    </td>
                    <td style={{ minWidth: 130 }}>
                      <div className="row">
                        <Meter p={rate} />
                        <span className="xs">{rate}%</span>
                      </div>
                    </td>
                    <td className="num">{won(p.budget_amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
