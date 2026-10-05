import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { demoMembers, demoProjectsList, demoTasks } from "./mockup/demo";
import {
  DueLabel,
  Empty,
  PageHead,
  Pill,
  TASK_STATUS,
  TASK_TONE,
} from "./mockup/lib";

const PRIO: Record<string, number> = { 높음: 0, 보통: 1, 낮음: 2 };

// TSK-001 업무 — 목업 tasksView() 이식
export function TasksScreen() {
  const [q, setQ] = useState("");
  const [proj, setProj] = useState("");
  const [who, setWho] = useState("");
  const [st, setSt] = useState("open");
  const [sort, setSort] = useState("due");

  const list = demoTasks
    .filter(
      (t) =>
        (!q || t.title.includes(q)) &&
        (!proj || t.project === proj) &&
        (!who || t.assignee === who) &&
        (st === "all" ? true : st === "open" ? t.status !== "done" : t.status === st),
    )
    .sort((a, b) =>
      sort === "prio"
        ? (PRIO[a.priority] ?? 9) - (PRIO[b.priority] ?? 9) || a.due.localeCompare(b.due)
        : sort === "title"
          ? a.title.localeCompare(b.title)
          : a.due.localeCompare(b.due),
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
          {demoProjectsList.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="담당자">
          <option value="">모든 담당자</option>
          {demoMembers.map((m) => (
            <option key={m} value={m}>
              {m}
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
        <button type="button" className="btn btn-sm">
          현재 보기 저장
        </button>
      </div>
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input type="checkbox" aria-label="전체 선택" />
              </th>
              <th>업무</th>
              <th>프로젝트</th>
              <th>담당</th>
              <th>상태</th>
              <th>우선순위</th>
              <th>마감</th>
            </tr>
          </thead>
          <tbody>
            {list.length ? (
              list.map((t) => (
                <tr key={t.id}>
                  <td>
                    <input type="checkbox" aria-label={`${t.title} 선택`} />
                  </td>
                  <td>
                    <Link className="t-title" to={`/tasks/${t.id}`}>
                      {t.title}
                    </Link>
                    {t.ai && <span className="pill ai"> AI 생성</span>}
                    {t.source && <span className="sub">근거: {t.source}</span>}
                  </td>
                  <td className="muted">{t.project}</td>
                  <td className="nowrap">{t.assignee}</td>
                  <td>
                    <Pill tone={TASK_TONE[t.status]}>{TASK_STATUS[t.status]}</Pill>
                  </td>
                  <td>
                    <Pill tone={t.priority === "높음" ? "bad" : "muted"}>{t.priority}</Pill>
                  </td>
                  <td className="nowrap">
                    {fmtDue(t.due)} <DueLabel due={t.due} done={t.status === "done"} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7}>
                  <Empty title="조건에 맞는 업무가 없습니다" desc="필터를 바꿔 보세요." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        {list.length}건 · 서버에서는 cursor pagination(limit 20)으로 불러옵니다.
      </p>
    </>
  );
}

function fmtDue(s: string): string {
  const wd = ["일", "월", "화", "수", "목", "금", "토"];
  const d = new Date(s);
  return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, "0")} (${wd[d.getDay()]})`;
}
