import { useCallback, useEffect, useMemo, useState } from "react";
import type { z } from "zod";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { StatCard, type Stat } from "../components/ui/StatCard";
import { useMembers } from "../hooks/useMembers";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { AttendanceCorrectionPanel } from "./attendance/AttendanceCorrectionPanel";
import { KIND_LABELS, attendanceSchema, monthRange, type AttendanceRow } from "./attendance/model";

import "./attendance.css";
import "./leave/leave.css";

type Attendance = z.infer<typeof attendanceSchema>;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

export function AttendanceScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const now = new Date();
  const [tab, setTab] = useState<"mine" | "manage">("mine");
  const [monthOffset, setMonthOffset] = useState(0);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [today, setToday] = useState<AttendanceRow | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correctionsReloadKey, setCorrectionsReloadKey] = useState(0);

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );
  const members = useMembers(apiSession);

  const shown = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const shownYear = shown.getFullYear();
  const shownMonth = shown.getMonth();
  const range = monthRange(shownYear, shownMonth);

  const reload = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    try {
      const data = await apiRequest(`/hr/attendance?from=${range.from}&to=${range.to}`, {
        session: apiSession,
      });
      setAttendance(attendanceSchema.parse(data));
      setError(null);
    } catch (caught) {
      setAttendance(null);
      setError(userMessageOf(caught));
    }
  }, [apiSession, range.from, range.to]);

  const reloadToday = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    try {
      const day = todayIso();
      const data = await apiRequest(`/hr/attendance?from=${day}&to=${day}`, { session: apiSession });
      setToday(attendanceSchema.parse(data).items[0] ?? null);
    } catch {
      setToday(null);
    }
  }, [apiSession]);

  const reloadManagePermission = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    try {
      await apiRequest("/hr/attendance/corrections/pending", { session: apiSession });
      setCanManage(true);
    } catch {
      setCanManage(false);
    }
  }, [apiSession]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void reloadToday();
    void reloadManagePermission();
  }, [reloadToday, reloadManagePermission]);

  async function checkIn(): Promise<void> {
    if (!apiSession) return;
    setCheckBusy(true);
    setError(null);
    try {
      await apiRequest("/hr/attendance/check-in", { method: "POST", session: apiSession });
      await Promise.all([reload(), reloadToday()]);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setCheckBusy(false);
    }
  }

  async function checkOut(): Promise<void> {
    if (!apiSession) return;
    setCheckBusy(true);
    setError(null);
    try {
      await apiRequest("/hr/attendance/check-out", { method: "POST", session: apiSession });
      await Promise.all([reload(), reloadToday()]);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setCheckBusy(false);
    }
  }

  const byKind = attendance?.summary.by_kind ?? {};
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
  ];

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
          <Button
            tone="neutral"
            size="small"
            disabled={checkBusy || Boolean(today?.check_in_at)}
            onClick={() => void checkIn()}
          >
            {today?.check_in_at ? `출근 ${formatTime(today.check_in_at)}` : "출근"}
          </Button>
          <Button
            tone="neutral"
            size="small"
            disabled={checkBusy || !today?.check_in_at || Boolean(today?.check_out_at)}
            onClick={() => void checkOut()}
          >
            {today?.check_out_at ? `퇴근 ${formatTime(today.check_out_at)}` : "퇴근"}
          </Button>
          <Button tone="neutral" size="small" onClick={() => void reload()}>
            새로 고침
          </Button>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}

      {canManage && (
        <div className="leave-tabs" role="tablist" aria-label="근태 화면 전환">
          <button type="button" role="tab" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>
            내 근태
          </button>
          <button type="button" role="tab" aria-pressed={tab === "manage"} onClick={() => setTab("manage")}>
            관리
          </button>
        </div>
      )}

      {tab === "manage" && canManage ? (
        apiSession && (
          <AttendanceCorrectionPanel
            apiSession={apiSession}
            mode="manage"
            members={members}
            reloadKey={correctionsReloadKey}
            onChanged={() => setCorrectionsReloadKey((value) => value + 1)}
          />
        )
      ) : (
        <>
          <section className="stat-grid" aria-label="내 근태 요약">
            {myStats.map((stat) => (
              <StatCard key={stat.label} stat={stat} />
            ))}
          </section>

          <SectionCard
            title="내 근태 기록"
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
          >
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

          {apiSession && <AttendanceCorrectionPanel apiSession={apiSession} mode="mine" onChanged={() => void reload()} />}
        </>
      )}
    </div>
  );
}
