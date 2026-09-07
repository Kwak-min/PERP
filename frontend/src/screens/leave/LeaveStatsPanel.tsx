import { useEffect, useMemo, useState } from "react";

import { SectionCard } from "../../components/ui/SectionCard";
import { StatCard, type Stat } from "../../components/ui/StatCard";
import { Button } from "../../components/ui/Button";
import type { OrgMember } from "../../hooks/useMembers";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { LEAVE_KIND_LABELS, leaveStatsSchema, type LeaveListItem, type LeaveStats } from "../attendance/model";

const STATUS_LABELS: Readonly<Record<string, string>> = { approved: "승인", pending: "대기", rejected: "반려" };
const FILTERS = ["전체", "대기", "승인", "반려"] as const;
const FILTER_TO_STATUS: Readonly<Record<string, string | null>> = {
  전체: null,
  대기: "pending",
  승인: "approved",
  반려: "rejected",
};

function escapeCsv(cell: string): string {
  return /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function downloadCsv(name: string, columns: readonly string[], rows: readonly (readonly string[])[]): void {
  const csv = [columns.map(escapeCsv).join(","), ...rows.map((row) => row.map(escapeCsv).join(","))].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

type Props = Readonly<{
  apiSession: ApiSession;
  members: readonly OrgMember[];
  leaves: readonly LeaveListItem[];
  reloadKey: number;
}>;

/** 조직 전체 휴가 소진율과 이력을 보여준다. 산식·기준시각을 함께 표시해 SFR-028 요건을 맞춘다. */
export function LeaveStatsPanel({ apiSession, members, leaves, reloadKey }: Props) {
  const [stats, setStats] = useState<LeaveStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("전체");

  useEffect(() => {
    let cancelled = false;
    apiRequest("/pg/hr/leave-stats", { session: apiSession })
      .then((data) => {
        if (!cancelled) setStats(leaveStatsSchema.parse(data));
      })
      .catch((caught) => {
        if (!cancelled) setError(userMessageOf(caught));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiSession.token, apiSession.orgId, reloadKey]);

  const memberName = (userId: string) => members.find((member) => member.user_id === userId)?.name ?? "구성원";

  const totalsStats: readonly Stat[] = stats
    ? [
        {
          label: "조직 부여 합계",
          value: String(stats.totals.granted_days),
          unit: "일",
          delta: `${stats.items.length}건 기준`,
          trend: "flat",
          foot: `${stats.formula} · ${formatTime(stats.generated_at)} 기준`,
        },
        {
          label: "조직 사용 합계",
          value: String(stats.totals.used_days),
          unit: "일",
          delta: "승인된 휴가만 반영",
          trend: "flat",
          foot: `${stats.formula} · ${formatTime(stats.generated_at)} 기준`,
        },
        {
          label: "조직 소진율",
          value: String(stats.totals.usage_rate),
          unit: "%",
          delta: stats.totals.usage_rate >= 70 ? "높음" : "정상",
          trend: stats.totals.usage_rate >= 70 ? "down" : "flat",
          foot: `${stats.formula} · ${formatTime(stats.generated_at)} 기준`,
        },
      ]
    : [];

  const filteredLeaves = useMemo(() => {
    const status = FILTER_TO_STATUS[filter];
    return status ? leaves.filter((leave) => leave.status === status) : leaves;
  }, [leaves, filter]);

  return (
    <div className="leave-stats">
      {error && <div className="form-error" role="alert">{error}</div>}

      {stats && (
        <section className="stat-grid" aria-label="휴가 통계">
          {totalsStats.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </section>
      )}

      {stats && (
        <SectionCard title="구성원별 소진율" subtitle="부여·사용·잔여 대비 소진율">
          {stats.items.length === 0 ? (
            <p className="attendance-empty">부여된 휴가가 아직 없습니다.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="구성원별 소진율" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th>구성원</th>
                    <th>종류</th>
                    <th className="num">부여</th>
                    <th className="num">사용</th>
                    <th className="num">잔여</th>
                    <th className="num">소진율</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.items.map((item) => (
                    <tr key={`${item.member_id}-${item.kind}`}>
                      <td>{memberName(item.member_id)}</td>
                      <td>{LEAVE_KIND_LABELS[item.kind] ?? item.kind}</td>
                      <td className="num">{item.granted_days}</td>
                      <td className="num">{item.used_days}</td>
                      <td className="num">{item.remaining_days}</td>
                      <td className="num">{item.usage_rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      <SectionCard
        title="휴가 이력"
        subtitle="상태별로 필터링해 확인합니다"
        action={
          <Button
            tone="neutral"
            size="small"
            disabled={filteredLeaves.length === 0}
            onClick={() =>
              downloadCsv(
                "휴가 이력",
                ["신청자", "유형", "시작", "종료", "일수", "상태"],
                filteredLeaves.map((leave) => [
                  memberName(leave.member_id),
                  LEAVE_KIND_LABELS[leave.kind] ?? leave.kind,
                  leave.start_on,
                  leave.end_on,
                  String(leave.days),
                  STATUS_LABELS[leave.status] ?? leave.status,
                ]),
              )
            }
          >
            CSV 내보내기
          </Button>
        }
      >
        <div className="filter-bar">
          {FILTERS.map((label) => (
            <button
              key={label}
              type="button"
              aria-pressed={filter === label}
              className={filter === label ? "chip chip--on" : "chip"}
              onClick={() => setFilter(label)}
            >
              {label}
            </button>
          ))}
          <span className="filter-bar__result">{filteredLeaves.length}건</span>
        </div>
        {filteredLeaves.length === 0 ? (
          <p className="attendance-empty">조건에 맞는 휴가 이력이 없습니다.</p>
        ) : (
          <div className="table-wrap" role="region" aria-label="휴가 이력" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>신청자</th>
                  <th>유형</th>
                  <th>기간</th>
                  <th className="num">일수</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeaves.map((leave) => (
                  <tr key={leave.id}>
                    <td>{memberName(leave.member_id)}</td>
                    <td>{LEAVE_KIND_LABELS[leave.kind] ?? leave.kind}</td>
                    <td>{leave.start_on} ~ {leave.end_on}</td>
                    <td className="num">{leave.days}</td>
                    <td>{STATUS_LABELS[leave.status] ?? leave.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
