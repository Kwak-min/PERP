import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { StateBoundary } from "../components/common/StateBoundary";
import { AssetCustodyModal } from '../components/common/AssetCustodyModal';
import { CalendarSurface } from "../components/data/CalendarSurface";
import { isOperationalScreen, OperationalSurface } from "../components/data/OperationalSurface";
import { CreateFormModal } from "../components/common/CreateFormModal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { StatCard, type Stat } from "../components/ui/StatCard";
import { StatTrendModal, metricKeyOf, type MetricKey } from "../components/data/StatTrendModal";
import { MemberListModal, membersSchema, type Member } from "../components/data/MemberListModal";
import { allFilter, screenFilters } from "./screenFilters";
import { downloadCsv, filterTable, liveTable, paginateTable, type TableData, type TableRow } from "./screenTable";
import { apiRequest, userMessageOf } from "../services/api";
import { isPgWorkspace, workspaceEndpoint } from "../services/workspace";
import { useDepartments } from "../hooks/useDepartments";
import { useResource } from "../hooks/useResource";
import { useRoles } from "../hooks/useRoles";
import { sectionLabels, type ScreenDefinition, type CreateConfig } from "../routes/catalog";
import { useSession } from "../store/session";
import { useBranch } from "../store/branch";

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
        { label: "조회 항목", value: String(records.length), unit: "건", delta: "전체 목록", trend: "flat", foot: "서버 데이터" },
      ];
    }
  }
  const scalars = Object.entries(data).filter(
    ([, value]) => typeof value === "number" || typeof value === "string",
  );
  if (scalars.length >= 3) {
    const labels: Readonly<Record<string, string>> = {
      members: "구성원",
      projects: "프로젝트",
      tasks: "업무",
      documents: "문서",
      assets: "자산",
      notifications: "알림",
      org_id: "조직",
      tenant_id: "테넌트",
      mode: "운영 모드",
      policy_mode: "정책 모드",
      provider: "제공자",
      status: "상태",
    };
    const valueLabels: Readonly<Record<string, string>> = {
      active: "활성",
      inactive: "비활성",
      strict: "엄격",
      balanced: "균형",
      permissive: "허용",
      enabled: "사용",
      disabled: "사용 안 함",
    };
    return scalars.slice(0, 4).map(([key, value]) => ({
      label: labels[key] ?? key.replaceAll("_", " "),
      value: typeof value === "number"
        ? value.toLocaleString("ko-KR")
        : valueLabels[String(value)] ?? (/^[0-9a-f-]{32,}$/i.test(String(value)) ? "내부 식별자" : String(value)),
      delta: "실시간",
      trend: "flat" as const,
      foot: "서버 데이터",
    }));
  }
  return null;
}

const MEMBER_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "활성",
  inactive: "휴면",
  left: "탈퇴",
};

function membersTable(
  data: unknown,
  departments: readonly { id: string; name: string }[],
  roles: readonly { key: string; label: string }[],
): TableData | null {
  if (!data || typeof data !== "object" || !("items" in data)) return null;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const parsed = membersSchema.safeParse(data);
  if (!parsed.success) return null;

  const deptName = new Map(departments.map((department) => [department.id, department.name]));
  const roleLabel = new Map(roles.map((role) => [role.key, role.label]));
  const columns = ["이름", "이메일", "역할", "부서", "상태"];
  const rows = parsed.data.items.map((member: Member): TableRow => {
    const role = member.roles.map((key) => roleLabel.get(key) ?? key).join(" · ") || "역할 미지정";
    const department = member.department_id
      ? deptName.get(member.department_id) ?? member.department_id
      : "미지정";
    const status = MEMBER_STATUS_LABELS[member.status] ?? member.status;
    return { id: member.membership_id, values: member, cells: [member.name, member.email, role, department, status] };
  });
  return { columns, rows };
}

function liveFacts(data: unknown): Readonly<{ key: string; value: string }[]> | null {
  if (!data || typeof data !== "object" || !("items" in data)) return null;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const record = items[0];
  if (!record || typeof record !== "object") return null;
  const FACT_LABELS: Readonly<Record<string, string>> = {
    id: "식별자",
    name: "이름",
    email: "이메일",
    status: "상태",
    created_at: "생성일",
    updated_at: "수정일",
  };
  return Object.entries(record as Record<string, unknown>)
    .slice(0, 6)
    .map(([key, value]) => ({
      key: FACT_LABELS[key] ?? key.replaceAll("_", " "),
      value: value === null || value === undefined ? "—" : String(value),
    }));
}

function passedDetailFacts(state: unknown): Readonly<{ key: string; value: string }[]> | null {
  if (!state || typeof state !== "object") return null;
  const { columns, row } = state as { columns?: unknown; row?: unknown };
  if (!Array.isArray(columns) || !Array.isArray(row)) return null;
  return columns.map((column, index) => ({
    key: String(column).replaceAll("_", " "),
    value: row[index] === undefined || row[index] === null ? "—" : String(row[index]),
  }));
}

const PASSED_STAT_LABELS: Readonly<Record<string, string>> = {
  id: "식별자",
  status: "상태",
  name: "이름",
  category: "분류",
  quantity: "수량",
  threshold: "임계",
  assignee: "담당자",
  owner: "책임자",
};

const PASSED_STAT_VALUE_LABELS: Readonly<Record<string, string>> = {
  active: "활성",
  available: "사용 가능",
  inactive: "비활성",
  disposed: "폐기",
  maintained: "점검 중",
};

function passedStatValue(raw: string): string {
  const localized = PASSED_STAT_VALUE_LABELS[raw];
  if (localized) return localized;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return "내부 식별자";
  }
  return raw;
}

function passedDetailStats(state: unknown): readonly Stat[] | null {
  if (!state || typeof state !== "object") return null;
  const { columns, row } = state as { columns?: unknown; row?: unknown };
  if (!Array.isArray(columns) || !Array.isArray(row)) return null;
  const stats: Stat[] = [];
  for (let index = 0; index < Math.min(columns.length, row.length); index += 1) {
    const key = String(columns[index]);
    const label = PASSED_STAT_LABELS[key] ?? key.replaceAll("_", " ");
    const raw = row[index] === undefined || row[index] === null ? "—" : String(row[index]);
    stats.push({
      label,
      value: passedStatValue(raw),
      delta: "실측",
      trend: "flat",
      foot: "서버 데이터",
    });
  }
  return stats.length > 0 ? stats : null;
}

function DataTable({
  table,
  onRowClick,
  onDelete,
  onEdit,
  onCustody,
}: Readonly<{
  table: TableData;
  onRowClick?: (row: readonly string[], index: number) => void;
  onDelete?: (row: TableRow) => void;
  onEdit?: (id: string) => void;
  onCustody?: (row: TableRow) => void;
}>) {
  const canDelete = Boolean(onDelete);
  const canEdit = Boolean(onEdit);
  const canAct = canDelete || canEdit || Boolean(onCustody);
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
            {canAct && <th aria-label="작업" />}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr
              key={row.id ?? index}
              className={onRowClick ? "table-row--interactive" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row.cells, index) : undefined}
              onKeyDown={onRowClick ? (event) => {
                if (event.key === "Enter" || event.key === " ") onRowClick(row.cells, index);
              } : undefined}
            >
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex} className={isNumericColumn(table.columns[cellIndex] ?? "") ? "num" : undefined}>
                  {cell}
                </td>
              ))}
              {canAct && (
                <td>
                  <span className="row-actions">
                    {onCustody && row.id && <Button tone="ghost" size="small" onClick={event => { event.stopPropagation(); onCustody(row); }}>담당·상태</Button>}
                    {canEdit && row.id ? (
                      <Button
                        tone="ghost"
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (row.id) onEdit?.(row.id);
                        }}
                      >
                        수정
                      </Button>
                    ) : null}
                    {canDelete && row.id ? (
                      <Button
                        tone="ghost"
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (row.id && window.confirm("이 항목을 삭제할까요?")) onDelete?.(row);
                        }}
                      >
                        삭제
                      </Button>
                    ) : null}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailAction({
  to,
  onClick,
  label = "자세히 보기",
}: Readonly<{ to?: string; onClick?: () => void; label?: string }>) {
  if (to) {
    return (
      <Link className="button button--ghost button--small" to={to}>
        자세히
      </Link>
    );
  }
  return (
    <Button tone="ghost" size="small" onClick={onClick} aria-label={label}>
      자세히
    </Button>
  );
}

export function ScreenPage({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  if (screen.id === "CAL-001" || screen.id === "CAL-002") return <CalendarSurface screen={screen} />;
  return <GenericScreenPage screen={screen} />;
}

function GenericScreenPage({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const location = useLocation();
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
  const [reloadKey, setReloadKey] = useState(0);
  const resource = useResource(endpoint, apiSession, reloadKey);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState(0);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  // 구성원 지표는 실제 가입·탈퇴 기록으로 기간별 추이를 보여줄 수 있다.
  const trendable = (screen.endpoint ?? "").startsWith("/members");
  const [trend, setTrend] = useState<{ stat: Stat; metric: MetricKey } | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [custodyId, setCustodyId] = useState<string | null>(null);
  const [quickModal, setQuickModal] = useState<"create" | "edit" | null>(null);
  const [editModal, setEditModal] = useState<{ config: CreateConfig; initialValues: Record<string, string> } | null>(null);
  const departments = useDepartments(apiSession);
  const roles = useRoles(apiSession);

  useEffect(() => {
    setQuery(new URLSearchParams(location.search).get("q") ?? "");
    setPage(1);
  }, [location.search]);

  useEffect(() => {
    setActiveFilter(0);
    setPage(1);
  }, [screen.id, session?.orgId, endpoint]);

  // 로딩·오류·빈 응답은 서버 상태 그대로 표시한다.
  const serverAnswered = resource.status === "ready" || resource.status === "empty";
  const blocked = resource.status === "forbidden" || resource.status === "error";
  const serverStats = serverAnswered ? liveStats(resource.data) : null;
  const serverTable =
    serverAnswered
      ? screen.path === "/members"
        ? membersTable(resource.data, departments, roles)
        : liveTable(resource.data)
      : null;
  const serverFacts = serverAnswered ? liveFacts(resource.data) : null;
  const hasServerContent = Boolean(serverStats || serverTable || serverFacts);
  const serverEmpty = resource.status === "empty" && !hasServerContent;

  const pgWorkspace = isPgWorkspace(session?.orgId);
  const deleteResource = pgWorkspace && screen.id !== 'AST-001' ? screen.deleteResource : undefined;
  const handleDelete = deleteResource
    ? async (row: TableRow) => {
        try {
          const financial = ['transactions', 'budgets', 'settlements', 'dues'].includes(deleteResource);
          await apiRequest(`/pg/records/${deleteResource}/${row.id}`, {
            method: "DELETE",
            ...(financial ? { body: { expected_version: row.values.__version ?? row.values.version } } : {}),
            ...(apiSession ? { session: apiSession } : {}),
          });
          setReloadKey((key) => key + 1);
          setNotice("삭제했습니다.");
        } catch (error) {
          setNotice(userMessageOf(error));
        }
      }
    : undefined;

  const editResource = pgWorkspace && screen.id !== 'AST-001' ? screen.editResource : undefined;
  const editCreateConfig = screen.create;
  const handleEdit = editResource && editCreateConfig
    ? async (id: string) => {
        try {
          const data = (await apiRequest(`/pg/records/${editResource}/${id}`, {
            ...(apiSession ? { session: apiSession } : {}),
          })) as Record<string, unknown>;
          const initialValues: Record<string, string> = {};
          for (const [key, value] of Object.entries(data)) {
            initialValues[key] = value == null ? "" : String(value);
          }
          // 수정 폼: 생성 필드 중 select(FK) 제외 = 편집 가능한 스칼라 필드.
          const fields = editCreateConfig.fields.filter((f) => f.type !== "select");
          setEditModal({
            config: { endpoint: `/pg/records/${editResource}/${id}`, fields },
            initialValues,
          });
        } catch (error) {
          setNotice(userMessageOf(error));
        }
      }
    : undefined;
  const passedFacts = passedDetailFacts(location.state);
  const passedStats = passedDetailStats(location.state);
  const detailFacts = passedFacts ?? serverFacts ?? [];
  const stats = serverStats ?? passedStats ?? [];
  const baseTable = serverTable;
  const filters = screenFilters[screen.id] ?? [allFilter];
  const selectedFilter = filters[activeFilter] ?? allFilter;
  // 검색/상태는 전체 응답에 적용하고, 화면 페이지만 마지막에 잘라낸다.
  const table = baseTable ? filterTable(baseTable, { query, filter: selectedFilter }) : undefined;
  const pagination = table ? paginateTable(table, page) : undefined;

  if (!pgWorkspace && isOperationalScreen(screen.id) && apiSession) {
    const operationalScreen = { ...screen, endpoint: screen.endpoint ? workspaceEndpoint(screen.endpoint, apiSession.orgId) : null };
    return <OperationalSurface screen={operationalScreen} session={apiSession} />;
  }

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">{sectionLabels[screen.section]}</span>
            <Badge>{screen.id}</Badge>
            {screen.module && <Badge>{screen.module}</Badge>}
            {screen.ai && <Badge tone="ai">AI 검토 필요</Badge>}
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
                setNotice(`${screen.label} 필터 결과 전체 ${table.rows.length}행을 CSV로 내려받았습니다.`);
              }
            }}
          >
            필터 결과 전체 내보내기
          </Button>
          {pgWorkspace && !isDetail && screen.create && (
            <Button
              tone={screen.ai ? "ai" : "primary"}
              size="small"
              onClick={() => setQuickModal("create")}
            >
              새로 만들기
            </Button>
          )}
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
                label={screen.path === "/members" ? "구성원 목록 자세히 보기" : "자세히 보기"}
                onClick={() =>
                  screen.path === "/members"
                    ? setShowMembers(true)
                    : trendable
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

      {showMembers && (
        <MemberListModal
          session={apiSession}
          onClose={() => setShowMembers(false)}
        />
      )}

      {screen.endpoint && resource.status === "loading" ? (
        <SectionCard title="불러오는 중" subtitle="서버 응답 대기">
          <StateBoundary status="loading" error={null}>
            <div />
          </StateBoundary>
        </SectionCard>
      ) : blocked ? (
        <SectionCard title="상태" subtitle="서버 응답" >
          <StateBoundary status={resource.status} error={resource.error}>
            <div />
          </StateBoundary>
        </SectionCard>
      ) : isDetail && !screen.endpoint ? (
        <div className="detail-layout">
          <SectionCard title="상세 정보" subtitle="선택한 항목의 핵심 값" action={<DetailAction />}>
            <dl className="kv-list">
              {(detailFacts).map((fact) => (
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
        </div>
      ) : (
        <SectionCard
          title="목록"
          subtitle="권한 범위 안의 최신 데이터"
          action={
            <DetailAction
              label={screen.path === "/members" ? "구성원 목록 자세히 보기" : "자세히 보기"}
              {...(screen.path === "/members" ? { onClick: () => setShowMembers(true) } : {})}
            />
          }
          foot="서버 응답 기준"
        >
          <div className="filter-bar">
            <label className="compact-search">
              <span className="sr-only">이 화면에서 검색</span>
              <input
                type="search"
                placeholder="이 화면에서 검색"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setPage(1); }}
              />
            </label>
            {filters.map((filter, index) => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={index === activeFilter}
                className={index === activeFilter ? "chip chip--on" : "chip"}
                onClick={() => { setActiveFilter(index); setPage(1); }}
              >
                {filter.label}
              </button>
            ))}
            {/* 전체를 포함한 모든 필터에서 같은 자리에 건수를 보여준다. */}
            <span className="filter-bar__result">
              {table?.rows.length ?? 0}건
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
            {pagination ? (
              <DataTable
                table={pagination.table}
                {...(screen.id === 'AST-001' ? { onCustody: (row: TableRow) => {
                  if (row.id) setCustodyId(row.id);
                } } : {})}
                {...(handleDelete ? { onDelete: handleDelete } : {})}
                {...(handleEdit ? { onEdit: handleEdit } : {})}
              />
            ) : null}
          </StateBoundary>
          {pagination && table && (
            <nav className="filter-bar" aria-label="목록 페이지">
              <Button tone="ghost" size="small" aria-label="이전 페이지" disabled={pagination.currentPage === 1}
                onClick={() => setPage(pagination.currentPage - 1)}>이전</Button>
              <span aria-live="polite">{pagination.start}–{pagination.end} / {table.rows.length}건 · {pagination.currentPage} / {pagination.pageCount}페이지</span>
              <Button tone="ghost" size="small" aria-label="다음 페이지" disabled={pagination.currentPage === pagination.pageCount}
                onClick={() => setPage(pagination.currentPage + 1)}>다음</Button>
            </nav>
          )}
        </SectionCard>
      )}
      {quickModal && screen.create && quickModal === "create" && (
        <CreateFormModal
          entityLabel={screen.label}
          config={screen.create}
          session={apiSession}
          onClose={() => setQuickModal(null)}
          onCreated={() => {
            setReloadKey((key) => key + 1);
            setNotice(`${screen.label} 항목을 저장했습니다.`);
          }}
        />
      )}
      {custodyId && apiSession && <AssetCustodyModal id={custodyId} session={apiSession} onClose={() => setCustodyId(null)} onSaved={() => { setReloadKey(key => key + 1); setNotice('자산 담당·상태를 저장했습니다.'); }} />}
      {editModal && (
        <CreateFormModal
          entityLabel={screen.label}
          config={editModal.config}
          session={apiSession}
          method="PATCH"
          initialValues={editModal.initialValues}
          onClose={() => setEditModal(null)}
          onCreated={() => {
            setReloadKey((key) => key + 1);
            setNotice("수정했습니다.");
          }}
        />
      )}
    </div>
  );
}
