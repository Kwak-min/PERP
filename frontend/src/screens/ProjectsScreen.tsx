import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { PROJ_TONE, demoProjects, type DemoProject } from "./mockup/demo";
import { Av, Empty, Meter, PageHead, Pill, fmtDate, pct, won } from "./mockup/lib";

// PRJ-001 프로젝트 — 목업 projects list 이식
export function ProjectsScreen() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [view, setView] = useState<"card" | "list">("card");

  const list = demoProjects.filter(
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
          {["진행", "계획", "완료", "보류"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" /> 보관함 보기
        </label>
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

      {!list.length ? (
        <div className="panel">
          <Empty
            title="조건에 맞는 프로젝트가 없습니다"
            desc="필터를 바꾸거나 새 프로젝트를 만드세요."
          />
        </div>
      ) : view === "card" ? (
        <div className="grid g3">
          {list.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
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
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link className="t-title" to={`/projects/${p.id}`}>
                      {p.name}
                    </Link>
                  </td>
                  <td>
                    <Pill tone={PROJ_TONE[p.status]}>{p.status}</Pill>
                  </td>
                  <td>{p.owner}</td>
                  <td className="nowrap">
                    {fmtDate(p.start)} – {fmtDate(p.end)}
                  </td>
                  <td style={{ minWidth: 130 }}>
                    <div className="row">
                      <Meter p={pct(p.done, p.total)} />
                      <span className="xs">{pct(p.done, p.total)}%</span>
                    </div>
                  </td>
                  <td className="num">{won(p.budget)}</td>
                  <td className="nowrap">
                    <button type="button" className="btn btn-xs">
                      템플릿 복제
                    </button>{" "}
                    <button type="button" className="btn btn-xs btn-ghost">
                      보관
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ProjectCard({ p }: { p: DemoProject }) {
  const rate = pct(p.done, p.total);
  return (
    <Link
      className="panel"
      to={`/projects/${p.id}`}
      style={{ color: "inherit", display: "grid", gap: 10, padding: 16 }}
    >
      <div className="row between">
        <Pill tone={PROJ_TONE[p.status]}>{p.status}</Pill>
        <span className="muted xs">
          {fmtDate(p.start)} – {fmtDate(p.end)}
        </span>
      </div>
      <div>
        <b style={{ fontSize: 15 }}>{p.name}</b>
        <p className="muted sm" style={{ marginTop: 4 }}>
          {p.desc}
        </p>
      </div>
      <div className="row between">
        <span className="av-stack">
          {p.members.slice(0, 5).map((m) => (
            <Av key={m} name={m} size="sm" />
          ))}
        </span>
        <span className="xs muted">
          업무 {p.done}/{p.total} · {rate}%
        </span>
      </div>
      <Meter p={rate} />
    </Link>
  );
}
