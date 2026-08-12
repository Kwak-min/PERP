import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { z } from "zod";

import { MonthCalendar } from "../components/data/MonthCalendar";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { StatCard, type Stat } from "../components/ui/StatCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { LeaveRequestForm } from "./attendance/LeaveRequestForm";
import {
  KIND_LABELS,
  LEAVE_KIND_LABELS,
  attendanceSchema,
  balanceSchema,
  leaveCalendarSchema,
  leaveEventsOf,
  monthRange,
} from "./attendance/model";

import "./attendance.css";

type Attendance = z.infer<typeof attendanceSchema>;
type Balances = z.infer<typeof balanceSchema>["items"];
type LeaveItems = z.infer<typeof leaveCalendarSchema>["items"];

export function AttendanceScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const now = new Date();
  const [monthOffset, setMonthOffset] = useState(0);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [balances, setBalances] = useState<Balances>([]);
  const [leaves, setLeaves] = useState<LeaveItems>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );

  const shown = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const shownYear = shown.getFullYear();
  const shownMonth = shown.getMonth();
  const range = monthRange(shownYear, shownMonth);

  const reload = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    const results = await Promise.allSettled([
      apiRequest(`/hr/attendance?from=${range.from}&to=${range.to}`, { session: apiSession }),
      apiRequest("/hr/leave-balances", { session: apiSession }),
      apiRequest(`/hr/leaves/calendar?from=${range.from}&to=${range.to}`, { session: apiSession }),
    ]);
    const [attendanceResult, balanceResult, leaveResult] = results;
    setAttendance(
      attendanceResult.status === "fulfilled" ? attendanceSchema.parse(attendanceResult.value) : null,
    );
    setBalances(
      balanceResult.status === "fulfilled" ? balanceSchema.parse(balanceResult.value).items : [],
    );
    setLeaves(
      leaveResult.status === "fulfilled" ? leaveCalendarSchema.parse(leaveResult.value).items : [],
    );
    const failure = results.find((result) => result.status === "rejected");
    setError(failure && failure.status === "rejected" ? userMessageOf(failure.reason) : null);
  }, [apiSession, range.from, range.to]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byKind = attendance?.summary.by_kind ?? {};
  const remaining = balances.reduce((sum, balance) => sum + balance.remaining_days, 0);
  const lastRecord = attendance?.items[0] ?? null;

  const myStats: readonly Stat[] = [
    {
      label: "이번 달 출근",
      value: String(byKind.present ?? 0),
      unit: "일",
      delta: `기록 ${attendance?.summary.total_days ?? 0}건`,
      trend: "flat",
      foot: `${shownYear}년 ${shownMonth + 1}월`,
    },
    {
      label: "지각·결근",
      value: String((byKind.late ?? 0) + (byKind.absent ?? 0)),
      unit: "회",
      delta: `원격 ${byKind.remote ?? 0}일`,
      trend: (byKind.late ?? 0) + (byKind.absent ?? 0) > 0 ? "down" : "flat",
      foot: "내 기록 기준",
    },
    {
      label: "총 활동시간",
      value: String(attendance?.summary.total_hours ?? 0),
      unit: "시간",
      delta: lastRecord ? `최근 근무 ${lastRecord.on_date}` : "기록 없음",
      trend: "flat",
      foot: lastRecord ? `${KIND_LABELS[lastRecord.kind] ?? lastRecord.kind} ${lastRecord.hours}시간` : "—",
    },
    {
      label: "잔여 휴가",
      value: String(remaining),
      unit: "일",
      delta: balances.length > 0 ? `${balances.length}종` : "부여 없음",
      trend: remaining > 0 ? "up" : "flat",
      foot: "승인된 휴가 차감 반영",
    },
  ];

  async function submitLeave(input: Readonly<{ kind: string; start_on: string; end_on: string; reason: string }>): Promise<void> {
    if (!apiSession) return;
    setBusy(true);
    setError(null);
    try {
      const created = (await apiRequest("/hr/leaves", {
        method: "POST",
        session: apiSession,
        body: input,
      })) as { approval_id?: string | null };
      setFormOpen(false);
      setNotice(
        created.approval_id
          ? "휴가 신청을 결재함으로 올렸습니다. 결재 화면에서 진행 상태를 확인하세요."
          : "휴가 신청을 접수했습니다. 결재자가 지정되지 않아 승인 대기 상태로 남습니다.",
      );
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const rows = attendance?.items ?? [];

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">사람</span>
            <Badge>{screen.id}</Badge>
            <Badge>HR</Badge>
          </div>
          <h1>{screen.label}</h1>
          <p>{screen.description}</p>
        </div>
        <div className="screen-header__actions">
          <Button tone="neutral" size="small" disabled={busy} onClick={() => void reload()}>
            새로 고침
          </Button>
          <Button size="small" onClick={() => setFormOpen((value) => !value)}>
            휴가 신청
          </Button>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Link className="button button--ghost button--small" to="/approvals">결재함 열기</Link>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      <section className="stat-grid" aria-label="내 근태 요약">
        {myStats.map((stat) => (
          <StatCard key={stat.label} stat={stat} />
        ))}
      </section>

      {formOpen && (
        <SectionCard padded title="휴가 신청" subtitle="사유만 적으면 결재로 넘어갑니다">
          <LeaveRequestForm busy={busy} onCancel={() => setFormOpen(false)} onSubmit={(input) => void submitLeave(input)} />
        </SectionCard>
      )}

      <div className="attendance-grid">
        <SectionCard
          padded
          title="내 휴가 잔여"
          subtitle="종류별 부여·사용·잔여"
          foot="승인된 휴가만 사용일수에 반영됩니다"
        >
          {balances.length === 0 ? (
            <p className="attendance-empty">부여된 휴가가 없습니다. 관리자에게 휴가 부여를 요청하세요.</p>
          ) : (
            <ul className="balance-list">
              {balances.map((balance) => (
                <li key={balance.id}>
                  <span>
                    <b>{LEAVE_KIND_LABELS[balance.kind] ?? balance.kind}</b>
                    <small>부여 {balance.granted_days}일 · 사용 {balance.used_days}일</small>
                  </span>
                  <strong>{balance.remaining_days}일</strong>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="내 근태 기록" subtitle={`${shownYear}년 ${shownMonth + 1}월`}>
          {rows.length === 0 ? (
            <p className="attendance-empty">이 달의 근태 기록이 없습니다.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="내 근태 기록" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th>일자</th>
                    <th>구분</th>
                    <th className="num">시간</th>
                    <th>출처</th>
                    <th>비고</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.on_date}</td>
                      <td>{KIND_LABELS[row.kind] ?? row.kind}</td>
                      <td className="num">{row.hours}</td>
                      <td>{row.source}</td>
                      <td>{row.note || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="전사 휴가 달력"
        subtitle={`${shownYear}년 ${shownMonth + 1}월 · 구성원 ${new Set(leaves.map((leave) => leave.member_id)).size}명`}
        action={
          <div className="calendar-nav">
            <Button tone="neutral" size="small" aria-label="이전 달" onClick={() => setMonthOffset((value) => value - 1)}>‹</Button>
            <span className="calendar-nav__label">
              {shownYear}. {String(shownMonth + 1).padStart(2, "0")}
            </span>
            <Button tone="neutral" size="small" aria-label="다음 달" onClick={() => setMonthOffset((value) => value + 1)}>›</Button>
          </div>
        }
        foot="초록색은 승인된 휴가, 노란색은 결재 대기 중인 휴가입니다"
      >
        {leaves.length === 0 ? (
          <p className="attendance-empty">이 달에 등록된 휴가가 없습니다.</p>
        ) : (
          <MonthCalendar
            year={shownYear}
            month={shownMonth}
            {...(monthOffset === 0 ? { today: now.getDate() } : {})}
            events={leaveEventsOf(leaves, shownYear, shownMonth)}
          />
        )}
      </SectionCard>
    </div>
  );
}
