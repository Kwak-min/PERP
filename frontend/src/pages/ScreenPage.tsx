import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { BarChart, DonutChart, ProgressList, Timeline } from "../components/data/Charts";
import { MonthCalendar } from "../components/data/MonthCalendar";
import { GanttChart } from "../components/data/GanttChart";
import { KanbanBoard } from "../components/data/KanbanBoard";
import { OrgTree } from "../components/data/OrgTree";
import { FlowCanvas, NodeGraph } from "../components/data/Graphs";
import { PermissionMatrix, WorkloadHeatmap } from "../components/data/Matrix";
import { StateBoundary } from "../components/common/StateBoundary";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { ListRow } from "../components/ui/ListRow";
import { SectionCard } from "../components/ui/SectionCard";
import { StatCard, type Stat } from "../components/ui/StatCard";
import { StatTrendModal, metricKeyOf, type MetricKey } from "../components/data/StatTrendModal";
import { fixtureFor, type ScreenFixture, type TableFixture } from "../fixtures/screens";
import { useResource } from "../hooks/useResource";
import { sectionLabels, type ScreenDefinition } from "../routes/catalog";
import { useSession } from "../store/session";
import { useBranch } from "../store/branch";
import { useDemoMode } from "../store/demo";

const NUMERIC_HINT = ["금액", "수량", "진행률", "시간", "건수", "잔액"];

function isNumericColumn(column: string): boolean {
  return NUMERIC_HINT.some((hint) => column.includes(hint));
}

function liveStats(data: unknown): readonly Stat[] | null {
  if (!data || typeof data !== "object") return null;
  if ("items" in data) {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items) && items.length > 0) {
      const records = items.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
      );
      const done = records.filter((item) =>
        ["completed", "confirmed", "done", "approved", "active"].includes(String(item.status)),
      ).length;
      const risk = records.filter((item) =>
        ["blocked", "overdue", "failed", "rejected", "pending"].includes(String(item.status)),
      ).length;
      const rate = records.length > 0 ? Math.round((done / records.length) * 100) : 0;
      return [
        { label: "전체 항목", value: String(records.length), unit: "건", delta: "실시간 조회", trend: "flat", foot: "서버 데이터" },
        { label: "완료·확정", value: String(done), unit: "건", delta: `${rate}%`, trend: rate >= 50 ? "up" : "down", foot: "서버 데이터" },
        { label: "확인 필요", value: String(risk), unit: "건", delta: risk > 0 ? "처리 권장" : "없음", trend: risk > 0 ? "down" : "flat", foot: "서버 데이터" },
        { label: "표시 중", value: String(Math.min(records.length, 8)), unit: "건", delta: "상위 8건", trend: "flat", foot: "서버 데이터" },
      ];
    }
  }
  const scalars = Object.entries(data).filter(
    ([, value]) => typeof value === "number" || typeof value === "string",
  );
  if (scalars.length >= 3) {
    return scalars.slice(0, 4).map(([key, value]) => ({
      label: key.replaceAll("_", " "),
      value: typeof value === "number" ? value.toLocaleString("ko-KR") : String(value),
      delta: "실시간",
      trend: "flat" as const,
      foot: "서버 데이터",
    }));
  }
  return null;
}

function liveTable(data: unknown): TableFixture | null {
  if (!data || typeof data !== "object" || !("items" in data)) return null;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const records = items.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
  if (records.length === 0) return null;
  const columns = Object.keys(records[0] ?? {}).slice(0, 6);
  return {
    columns,
    rows: records.slice(0, 8).map((record) =>
      columns.map((column) => {
        const value = record[column];
        if (value === null || value === undefined) return "—";
        if (typeof value === "number") return value.toLocaleString("ko-KR");
        if (typeof value === "boolean") return value ? "예" : "아니요";
        if (Array.isArray(value)) return `${value.length}개`;
        if (typeof value === "object") return "상세";
        return String(value);
      }),
    ),
  };
}

function DataTable({ table }: Readonly<{ table: TableFixture }>) {
  return (
    <div className="table-wrap" role="region" aria-label="데이터 표" tabIndex={0}>
      <p className="table-scroll-hint">표를 좌우로 스크롤해 모든 열을 확인할 수 있습니다.</p>
      <table>
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column} className={isNumericColumn(column) ? "num" : undefined}>
                {column.replaceAll("_", " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={isNumericColumn(table.columns[cellIndex] ?? "") ? "num" : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailAction({ to, onClick }: Readonly<{ to?: string; onClick?: () => void }>) {
  if (to) {
    return (
      <Link className="button button--ghost button--small" to={to}>
        자세히
      </Link>
    );
  }
  return (
    <Button tone="ghost" size="small" onClick={onClick} aria-label="자세히 보기">
      자세히
    </Button>
  );
}

function toCsv(table: TableFixture): string {
  const escape = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
  return [table.columns.map(escape).join(","), ...table.rows.map((row) => row.map(escape).join(","))].join("\n");
}

function downloadCsv(name: string, table: TableFixture): void {
  const blob = new Blob(["\uFEFF" + toCsv(table)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ScreenPage({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const params = useParams();
  const isDetail = Object.keys(params).length > 0;
  const apiSession = useMemo(
    () => (session ? { token: session.token, orgId: session.orgId } : null),
    [session],
  );
  // 프로젝트 계열 화면만 부서 브랜치로 좁힌다. 휴가·근태·회계는 전사 기준을 유지한다.
  const branchId = useBranch(session?.orgId ?? null);
  const branchScoped = screen.module === "projects" && branchId !== null;
  const endpoint = useMemo(() => {
    if (!screen.endpoint) return null;
    if (!branchScoped || !branchId) return screen.endpoint;
    const separator = screen.endpoint.includes("?") ? "&" : "?";
    return `${screen.endpoint}${separator}department_id=${encodeURIComponent(branchId)}`;
  }, [screen.endpoint, branchScoped, branchId]);
  const resource = useResource(endpoint, apiSession);
  const fixture: ScreenFixture = useMemo(
    () => fixtureFor(screen.id, isDetail),
    [screen.id, isDetail],
  );

  const demoMode = useDemoMode();
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // 구성원 지표는 실제 가입·탈퇴 기록으로 기간별 추이를 보여줄 수 있다.
  const trendable = (screen.endpoint ?? "").startsWith("/members");
  const [trend, setTrend] = useState<{ stat: Stat; metric: MetricKey } | null>(null);

  // 서버가 응답했으면(빈 결과 포함) 서버가 진실이다. 데모는 서버가 없을 때만 쓴다.
  const serverAnswered = resource.status === "ready" || resource.status === "empty";
  const blocked = !demoMode && (resource.status === "forbidden" || resource.status === "error");
  const serverStats = serverAnswered && !demoMode ? liveStats(resource.data) : null;
  const serverTable = serverAnswered && !demoMode ? liveTable(resource.data) : null;
  const serverEmpty = !demoMode && resource.status === "empty";
  const usingDemo = demoMode || !screen.endpoint || (!serverAnswered && !blocked);
  const stats = serverStats ?? (usingDemo ? fixture.stats : []);
  const baseTable = serverTable ?? (usingDemo ? fixture.table : undefined);
  const filters = fixture.filters ?? ["전체"];
  const filterWord = activeFilter === 0 ? "" : (filters[activeFilter] ?? "");

  const table = useMemo(() => {
    if (!baseTable) return undefined;
    const needle = query.trim().toLowerCase();
    let rows = baseTable.rows;
    if (needle) rows = rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(needle)));
    if (filterWord) rows = rows.filter((row) => row.some((cell) => cell.includes(filterWord)));
    return { ...baseTable, rows };
  }, [baseTable, query, filterWord]);

  const calendarBase = fixture.calendar;
  const shownDate = new Date(
    calendarBase?.year ?? 2026,
    (calendarBase?.month ?? 0) + monthOffset,
    1,
  );
  const shownYear = shownDate.getFullYear();
  const shownMonth = shownDate.getMonth();

  const visibleRows = useMemo(() => {
    const rows = usingDemo ? (fixture.rows ?? []) : [];
    const needle = query.trim().toLowerCase();
    let out = rows;
    if (needle) {
      out = out.filter(
        (row) =>
          row.title.toLowerCase().includes(needle) ||
          (row.subtitle ?? "").toLowerCase().includes(needle),
      );
    }
    if (filterWord) {
      out = out.filter(
        (row) =>
          row.title.includes(filterWord) ||
          (row.subtitle ?? "").includes(filterWord) ||
          (row.meta ?? "").includes(filterWord),
      );
    }
    return out;
  }, [fixture.rows, query, usingDemo, filterWord]);

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">{sectionLabels[screen.section]}</span>
            <Badge>{screen.id}</Badge>
            {screen.module && <Badge>{screen.module}</Badge>}
            {screen.ai && <Badge tone="ai">AI 검토 필요</Badge>}
            {usingDemo && <Badge tone="warning">데모 데이터</Badge>}
            {blocked && <Badge tone="danger">{resource.status === "forbidden" ? "권한 없음" : "연결 실패"}</Badge>}
            {serverEmpty && <Badge tone="neutral">데이터 없음</Badge>}
          </div>
          <h1>{screen.label}</h1>
          <p>{screen.description}</p>
        </div>
        <div className="screen-header__actions">
          <Button
            tone="neutral"
            size="small"
            disabled={!table}
            onClick={() => {
              if (table) {
                downloadCsv(screen.label, table);
                setNotice(`${screen.label} ${table.rows.length}행을 CSV로 내려받았습니다.`);
              }
            }}
          >
            내보내기
          </Button>
          <Button
            tone={screen.ai ? "ai" : "primary"}
            size="small"
            onClick={() => setNotice(`${screen.label} ${isDetail ? "편집" : "새로 만들기"}은 데모에서 준비 중입니다.`)}
          >
            {isDetail ? "편집" : "새로 만들기"}
          </Button>
        </div>
      </header>

      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)} aria-label="알림 닫기">닫기</Button>
        </div>
      )}

      <section className="stat-grid" aria-label={`${screen.label} 지표`}>
        {stats.map((stat, index) => (
          <StatCard
            key={stat.label}
            stat={stat}
            action={
              <DetailAction
                onClick={() =>
                  trendable
                    ? setTrend({ stat, metric: metricKeyOf(stat, index) })
                    : setNotice(`${stat.label}: ${stat.value}${stat.unit ?? ""} — ${stat.foot ?? "상세 분석 준비 중"}`)
                }
              />
            }
          />
        ))}
      </section>

      {trend && (
        <StatTrendModal
          stat={trend.stat}
          metric={trend.metric}
          session={apiSession}
          onClose={() => setTrend(null)}
        />
      )}

      {blocked ? (
        <SectionCard title="상태" subtitle="서버 응답" >
          <StateBoundary status={resource.status} error={resource.error}>
            <div />
          </StateBoundary>
        </SectionCard>
      ) : fixture.layout === "graph" && fixture.graph ? (
        <SectionCard title="관계 그래프" subtitle="위키링크와 백링크" action={<DetailAction onClick={() => setNotice("노드를 클릭하면 해당 노트로 이동합니다 (데모)")} />} foot="회색 노드는 연결이 없는 고아 노트입니다">
          <NodeGraph nodes={fixture.graph.nodes} edges={fixture.graph.edges} />
        </SectionCard>
      ) : fixture.layout === "flow" && fixture.flow ? (
        <SectionCard title="워크플로" subtitle="트리거 → 조건 → 액션" action={<DetailAction onClick={() => setNotice("샌드박스 테스트는 데모에서 준비 중입니다.")} />} foot="게시 전 샌드박스에서 실행해 볼 수 있습니다">
          <FlowCanvas nodes={fixture.flow} />
        </SectionCard>
      ) : fixture.layout === "heatmap" && fixture.heatmap ? (
        <SectionCard title="업무량" subtitle="구성원별 배정 시간" action={<DetailAction onClick={() => setNotice("셀을 클릭하면 해당 일자 업무 목록이 열립니다 (데모)")} />} foot="색이 진할수록 배정 시간이 많습니다 · 붉은 합계는 가용 시간 초과">
          <WorkloadHeatmap columns={fixture.heatmap.columns} rows={fixture.heatmap.rows} />
        </SectionCard>
      ) : fixture.layout === "matrix" && fixture.matrix ? (
        <SectionCard title="권한 매트릭스" subtitle="역할별 허용 범위" action={<DetailAction onClick={() => setNotice("권한 시뮬레이션은 데모에서 준비 중입니다.")} />} foot="기본 역할의 핵심 권한은 보호되어 변경할 수 없습니다">
          <PermissionMatrix roles={fixture.matrix.roles} rows={fixture.matrix.rows} />
        </SectionCard>
      ) : fixture.layout === "brief" && fixture.brief ? (
        <SectionCard title="오늘의 브리핑" subtitle="우선순위·결재·위험" action={<DetailAction onClick={() => setNotice("브리핑을 새로 생성했습니다 (데모)")} />} foot="각 항목은 원천 데이터와 연결되어 있습니다">
          <div className="brief-list">
            {fixture.brief.map((item) => (
              <article
                key={item.title}
                className={`brief-item${item.kind === "risk" ? " brief-item--risk" : item.kind === "approval" ? " brief-item--approval" : ""}`}
              >
                <b>{item.title}</b>
                <span>{item.note}</span>
                <cite>근거 · {item.source}</cite>
              </article>
            ))}
          </div>
        </SectionCard>
      ) : fixture.layout === "diff" && fixture.diff ? (
        <div className="detail-layout">
          <SectionCard title="변경 미리보기" subtitle="실행 전/후 비교" action={<DetailAction onClick={() => setNotice("승인 요청을 전송했습니다 (데모)")} />} foot="승인 후에만 실제 반영됩니다">
            <div className="diff">
              {fixture.diff.map((row) => (
                <div className="diff__row" key={row.field}>
                  <span className="diff__field">{row.field}</span>
                  <span className="diff__before">{row.before}</span>
                  <span className="diff__after">{row.after}</span>
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="실행 정보" subtitle="도구와 승인" action={<DetailAction onClick={() => setNotice("롤백은 실행 후 24시간 이내 가능합니다.")} />}>
            <dl className="kv-list">
              {(fixture.facts ?? []).map((fact) => (
                <div key={fact.key}>
                  <dt>{fact.key}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </SectionCard>
        </div>
      ) : fixture.layout === "kanban" && fixture.kanban ? (
        <SectionCard
          title="업무 보드"
          subtitle="상태별 진행 현황 · WIP 한도 표시"
          action={<DetailAction />}
          foot="열 머리글 수치는 현재 항목 수 / WIP 한도입니다"
        >
          <KanbanBoard columns={fixture.kanban} />
        </SectionCard>
      ) : fixture.layout === "gantt" && fixture.gantt ? (
        <SectionCard
          title="타임라인"
          subtitle="주 단위 일정과 마일스톤"
          action={<DetailAction />}
          foot="막대 수치는 진행률, 마름모는 마일스톤, 노란 막대는 지연 업무입니다"
        >
          <GanttChart
            columns={fixture.gantt.columns}
            tasks={fixture.gantt.tasks}
            todayIndex={fixture.gantt.todayIndex}
          />
        </SectionCard>
      ) : fixture.layout === "orgchart" && fixture.orgchart ? (
        <SectionCard title="조직도" subtitle="부서 구조와 책임자" action={<DetailAction />} foot="괄호 표기는 공석입니다">
          <OrgTree root={fixture.orgchart} />
        </SectionCard>
      ) : fixture.layout === "calendar" && fixture.calendar ? (
        <div className="grid-12">
          <div className="col-8">
            <SectionCard
              title="월간 일정"
              subtitle={`${shownYear}년 ${shownMonth + 1}월`}
              action={
                <div className="calendar-nav">
                  <Button tone="neutral" size="small" aria-label="이전 달" onClick={() => setMonthOffset((value) => value - 1)}>‹</Button>
                  <span className="calendar-nav__label">
                    {shownYear}. {String(shownMonth + 1).padStart(2, "0")}
                  </span>
                  <Button tone="neutral" size="small" aria-label="다음 달" onClick={() => setMonthOffset((value) => value + 1)}>›</Button>
                </div>
              }
              foot="개인·조직·프로젝트 일정을 통합해 표시합니다 · 10분 전 갱신"
            >
              <MonthCalendar
                year={shownYear}
                month={shownMonth}
                {...(monthOffset === 0 ? { today: fixture.calendar.today } : {})}
                events={monthOffset === 0 ? fixture.calendar.events : []}
              />
            </SectionCard>
          </div>
          <div className="col-4">
            <SectionCard
              title={fixture.rowsTitle ?? "다가오는 일정"}
              subtitle="권한 범위 안의 항목"
              action={<DetailAction />}
            >
              <div className="list-rows">
                {(fixture.rows ?? []).map((row) => (
                  <ListRow
                    key={row.title}
                    mark={row.mark}
                    time={row.time}
                    title={row.title}
                    subtitle={row.subtitle}
                    ai={row.ai ?? row.tone === "ai"}
                    meta={row.meta ? <Badge tone={row.tone ?? "neutral"}>{row.meta}</Badge> : null}
                  />
                ))}
              </div>
            </SectionCard>
            {fixture.timeline && (
              <SectionCard
                title={fixture.timelineTitle ?? "준비 단계"}
                subtitle="진행 순서"
                action={<DetailAction />}
                className="section-card--stacked"
              >
                <Timeline items={fixture.timeline} />
              </SectionCard>
            )}
          </div>
        </div>
      ) : fixture.layout === "detail" ? (
        <div className="detail-layout">
          <SectionCard title="상세 정보" subtitle="선택한 항목의 핵심 값" action={<DetailAction />}>
            <dl className="kv-list">
              {(fixture.facts ?? []).map((fact) => (
                <div key={fact.key}>
                  <dt>{fact.key}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
              <div>
                <dt>참조 키</dt>
                <dd>{Object.values(params).join(" · ") || "—"}</dd>
              </div>
            </dl>
          </SectionCard>
          <SectionCard title={fixture.timelineTitle ?? "활동 기록"} subtitle="변경 이력" action={<DetailAction />}>
            <Timeline items={fixture.timeline ?? []} />
          </SectionCard>
          {visibleRows.length > 0 && (
            <SectionCard
              title={fixture.rowsTitle ?? "연결 항목"}
              subtitle="관련 항목과 활동"
              action={<DetailAction />}
              className="detail-layout__wide"
            >
              <div className="list-rows">
                {visibleRows.map((row) => (
                  <ListRow
                    key={row.title}
                    mark={row.mark}
                    time={row.time}
                    title={row.title}
                    subtitle={row.subtitle}
                    ai={row.ai ?? row.tone === "ai"}
                    meta={row.meta ? <Badge tone={row.tone ?? "neutral"}>{row.meta}</Badge> : null}
                  />
                ))}
              </div>
            </SectionCard>
          )}
        </div>
      ) : fixture.layout === "dashboard" ? (
        <div className="grid-12">
          {fixture.bars && (
            <div className="col-8">
              <SectionCard
                title={fixture.barsTitle ?? "추이"}
                subtitle="최근 기간 기준"
                action={<DetailAction />}
                foot="집계 기준: 조직 전체 · 10분 전 갱신"
              >
                <BarChart bars={fixture.bars} />
              </SectionCard>
            </div>
          )}
          {fixture.slices && (
            <div className="col-4">
              <SectionCard title={fixture.donutTitle ?? "분포"} subtitle="비중" action={<DetailAction />}>
                <DonutChart
                  slices={fixture.slices}
                  centerValue={fixture.donutValue ?? "—"}
                  centerLabel={fixture.donutLabel ?? "합계"}
                />
              </SectionCard>
            </div>
          )}
          {fixture.rows && (
            <div className={fixture.progress ? "col-8" : "col-12"}>
              <SectionCard
                title={fixture.rowsTitle ?? "최근 항목"}
                subtitle="권한 범위 안의 항목"
                action={<DetailAction />}
              >
                <StateBoundary
                  status={visibleRows.length === 0 && !usingDemo ? "empty" : "ready"}
                  error={resource.error}
                >
                  <div className="list-rows">
                    {visibleRows.map((row) => (
                      <ListRow
                        key={row.title}
                        mark={row.mark}
                        time={row.time}
                        title={row.title}
                        subtitle={row.subtitle}
                        ai={row.ai ?? row.tone === "ai"}
                        meta={row.meta ? <Badge tone={row.tone ?? "neutral"}>{row.meta}</Badge> : null}
                      />
                    ))}
                  </div>
                </StateBoundary>
              </SectionCard>
            </div>
          )}
          {fixture.progress && (
            <div className="col-4">
              <SectionCard title={fixture.progressTitle ?? "진행률"} subtitle="목표 대비" action={<DetailAction />}>
                <ProgressList items={fixture.progress} />
              </SectionCard>
            </div>
          )}
          {fixture.timeline && !fixture.rows && (
            <div className="col-4">
              <SectionCard title={fixture.timelineTitle ?? "단계"} subtitle="진행 순서" action={<DetailAction />}>
                <Timeline items={fixture.timeline} />
              </SectionCard>
            </div>
          )}
          {table && (
            <div className="col-12">
              <SectionCard title="상세 목록" subtitle="상위 8건" action={<DetailAction />}>
                <DataTable table={table} />
              </SectionCard>
            </div>
          )}
        </div>
      ) : (
        <SectionCard
          title="목록"
          subtitle="권한 범위 안의 최신 데이터"
          action={<DetailAction />}
          foot={usingDemo ? "데모 데이터 · 서버 연결 시 실제 값으로 대체됩니다" : "서버 데이터 · 10분 전 갱신"}
        >
          <div className="filter-bar">
            <label className="compact-search">
              <span className="sr-only">이 화면에서 검색</span>
              <input
                type="search"
                placeholder="이 화면에서 검색"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {filters.map((filter, index) => (
              <button
                key={filter}
                type="button"
                aria-pressed={index === activeFilter}
                className={index === activeFilter ? "chip chip--on" : "chip"}
                onClick={() => setActiveFilter(index)}
              >
                {filter}
              </button>
            ))}
            {/* 전체를 포함한 모든 필터에서 같은 자리에 건수를 보여준다. */}
            <span className="filter-bar__result">
              {table ? table.rows.length : visibleRows.length}건
            </span>
          </div>
          <StateBoundary
            status={
              !table || table.rows.length === 0 ? "empty" : "ready"
            }
            error={resource.error}
            emptyTitle={query || activeFilter !== 0 ? "조건에 맞는 항목이 없습니다" : `아직 ${screen.label} 항목이 없습니다`}
            emptyDescription={
              query || activeFilter !== 0
                ? "검색어나 필터를 바꿔 다시 시도하세요."
                : "첫 항목을 추가하면 팀과 바로 공유할 수 있습니다."
            }
          >
            {table ? (
              <DataTable table={table} />
            ) : visibleRows.length > 0 ? (
              <div className="list-rows">
                {visibleRows.map((row) => (
                  <ListRow
                    key={row.title}
                    mark={row.mark}
                    time={row.time}
                    title={row.title}
                    subtitle={row.subtitle}
                    ai={row.ai ?? row.tone === "ai"}
                    meta={row.meta ? <Badge tone={row.tone ?? "neutral"}>{row.meta}</Badge> : null}
                  />
                ))}
              </div>
            ) : null}
          </StateBoundary>
        </SectionCard>
      )}
    </div>
  );
}
