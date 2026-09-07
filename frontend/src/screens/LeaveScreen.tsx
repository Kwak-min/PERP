import { useCallback, useEffect, useMemo, useState } from "react";
import type { z } from "zod";

import { MonthCalendar } from "../components/data/MonthCalendar";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { StatCard, type Stat } from "../components/ui/StatCard";
import { useLeavePolicies } from "../hooks/useLeavePolicies";
import { useMembers } from "../hooks/useMembers";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { LeaveRequestForm } from "./attendance/LeaveRequestForm";
import {
  LEAVE_KIND_LABELS,
  balanceSchema,
  leaveCalendarSchema,
  leaveEventsOf,
  leaveListSchema,
  monthRange,
  type LeaveListItem,
} from "./attendance/model";
import { LeaveGrantPanel } from "./leave/LeaveGrantPanel";
import { LeavePolicyPanel } from "./leave/LeavePolicyPanel";
import { LeaveStatsPanel } from "./leave/LeaveStatsPanel";

import "./attendance.css";
import "./leave/leave.css";

type Balances = z.infer<typeof balanceSchema>["items"];
type LeaveCalendarItems = z.infer<typeof leaveCalendarSchema>["items"];

const STATUS_TONE: Readonly<Record<string, "success" | "warning" | "danger" | "neutral">> = {
  approved: "success",
  pending: "warning",
  rejected: "danger",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  approved: "승인",
  pending: "대기",
  rejected: "반려",
};

export function LeaveScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const now = new Date();
  const [monthOffset, setMonthOffset] = useState(0);
  const [balances, setBalances] = useState<Balances>([]);
  const [calendarItems, setCalendarItems] = useState<LeaveCalendarItems>([]);
  const [myLeaves, setMyLeaves] = useState<readonly LeaveListItem[]>([]);
  const [reviewLeaves, setReviewLeaves] = useState<readonly LeaveListItem[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"mine" | "manage">("mine");
  const [statsReloadKey, setStatsReloadKey] = useState(0);

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );
  const members = useMembers(apiSession);
  const { policies, forbidden: managementForbidden, loading: policiesLoading, reload: reloadPolicies } =
    useLeavePolicies(apiSession);
  const canManage = !policiesLoading && !managementForbidden;
  const myUserId = useMemo(
    () => members.find((member) => member.email === session?.email)?.user_id ?? null,
    [members, session?.email],
  );
  const memberName = useCallback(
    (userId: string) => members.find((member) => member.user_id === userId)?.name ?? "구성원",
    [members],
  );

  const shown = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const shownYear = shown.getFullYear();
  const shownMonth = shown.getMonth();
  const range = monthRange(shownYear, shownMonth);

  const reload = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    const results = await Promise.allSettled([
      apiRequest("/pg/hr/leave-balances", { session: apiSession }),
      apiRequest(`/pg/hr/leaves/calendar?from=${range.from}&to=${range.to}`, { session: apiSession }),
      apiRequest("/pg/hr/leaves", { session: apiSession }),
    ]);
    const [balanceResult, calendarResult, leavesResult] = results;
    setBalances(
      balanceResult.status === "fulfilled" ? balanceSchema.parse(balanceResult.value).items : [],
    );
    setCalendarItems(
      calendarResult.status === "fulfilled" ? leaveCalendarSchema.parse(calendarResult.value).items : [],
    );
    if (leavesResult.status === "fulfilled") {
      const items = leaveListSchema.parse(leavesResult.value).items;
      // 서버는 leave.approve 권한이 없으면 본인 신청만 반환한다. 다른 사람 항목이 섞여 있으면
      // 승인 권한이 있다는 뜻이므로, 그 항목들만 별도로 "승인 대기 목록"에 보여준다.
      setMyLeaves(myUserId ? items.filter((item) => item.member_id === myUserId) : items);
      setReviewLeaves(myUserId ? items.filter((item) => item.member_id !== myUserId) : []);
    } else {
      setMyLeaves([]);
      setReviewLeaves([]);
    }
    const failure = results.find((result) => result.status === "rejected");
    setError(failure && failure.status === "rejected" ? userMessageOf(failure.reason) : null);
  }, [apiSession, range.from, range.to, myUserId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remaining = balances.reduce((sum, balance) => sum + balance.remaining_days, 0);
  const myPending = myLeaves.filter((leave) => leave.status === "pending").length;
  const reviewPending = reviewLeaves.filter((leave) => leave.status === "pending");
  const withSubstitute = myLeaves.filter((leave) => leave.substitute_id).length;

  const myStats: readonly Stat[] = [
    {
      label: "잔여 휴가",
      value: String(remaining),
      unit: "일",
      delta: balances.length > 0 ? `${balances.length}종` : "부여 없음",
      trend: remaining > 0 ? "up" : "flat",
      foot: "승인된 휴가 차감 반영",
    },
    {
      label: "내 승인 대기",
      value: String(myPending),
      unit: "건",
      delta: myPending > 0 ? "결재 진행 중" : "없음",
      trend: myPending > 0 ? "down" : "flat",
      foot: "내 신청 기준",
    },
    {
      label: "팀 승인 대기",
      value: String(reviewPending.length),
      unit: "건",
      delta: reviewPending.length > 0 ? "확인 필요" : "없음",
      trend: reviewPending.length > 0 ? "down" : "flat",
      foot: "승인 권한이 있을 때만 표시",
    },
    {
      label: "업무대행 지정",
      value: String(withSubstitute),
      unit: "건",
      delta: "내 신청 기준",
      trend: "flat",
      foot: "업무 공백 대비",
    },
  ];

  async function submitLeave(
    input: Readonly<{ kind: string; start_on: string; end_on: string; reason: string; substitute_id: string | null }>,
  ): Promise<void> {
    if (!apiSession) return;
    setBusy(true);
    setError(null);
    try {
      const created = (await apiRequest("/pg/hr/leaves", {
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

  async function decide(leaveId: string, decision: "approve" | "reject"): Promise<void> {
    if (!apiSession) return;
    setDecidingId(leaveId);
    setError(null);
    try {
      await apiRequest(`/pg/hr/leaves/${leaveId}/decide`, {
        method: "POST",
        session: apiSession,
        body: { decision },
      });
      setNotice(decision === "approve" ? "휴가를 승인했습니다." : "휴가를 반려했습니다.");
      await reload();
      setStatsReloadKey((value) => value + 1);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setDecidingId(null);
    }
  }

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
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      {canManage && (
        <div className="leave-tabs" role="tablist" aria-label="휴가 화면 전환">
          <button type="button" role="tab" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>
            내 휴가
          </button>
          <button type="button" role="tab" aria-pressed={tab === "manage"} onClick={() => setTab("manage")}>
            관리
          </button>
        </div>
      )}

      {tab === "manage" && canManage ? (
        <div className="leave-stats">
          <LeavePolicyPanel policies={policies} apiSession={apiSession!} onSaved={reloadPolicies} />
          <LeaveGrantPanel
            members={members}
            policies={policies}
            apiSession={apiSession!}
            onGranted={() => setStatsReloadKey((value) => value + 1)}
          />
          <LeaveStatsPanel
            apiSession={apiSession!}
            members={members}
            leaves={[...myLeaves, ...reviewLeaves]}
            reloadKey={statsReloadKey}
          />
        </div>
      ) : (
      <>
      <section className="stat-grid" aria-label="휴가 요약">
        {myStats.map((stat) => (
          <StatCard key={stat.label} stat={stat} />
        ))}
      </section>

      {formOpen && (
        <SectionCard padded title="휴가 신청" subtitle="사유만 적으면 결재로 넘어갑니다">
          <LeaveRequestForm
            busy={busy}
            members={members}
            currentEmail={session?.email ?? null}
            onCancel={() => setFormOpen(false)}
            onSubmit={(input) => void submitLeave(input)}
          />
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

        <SectionCard title="내 휴가 신청" subtitle="최근 신청 내역">
          {myLeaves.length === 0 ? (
            <p className="attendance-empty">신청한 휴가가 없습니다.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="내 휴가 신청" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th>유형</th>
                    <th>기간</th>
                    <th className="num">일수</th>
                    <th>업무대행</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {myLeaves.map((leave) => (
                    <tr key={leave.id}>
                      <td>{LEAVE_KIND_LABELS[leave.kind] ?? leave.kind}</td>
                      <td>{leave.start_on} ~ {leave.end_on}</td>
                      <td className="num">{leave.days}</td>
                      <td>{leave.substitute_id ? memberName(leave.substitute_id) : "—"}</td>
                      <td>
                        <Badge tone={STATUS_TONE[leave.status] ?? "neutral"}>
                          {STATUS_LABELS[leave.status] ?? leave.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      {reviewLeaves.length > 0 && (
        <SectionCard
          title="승인 대기 목록"
          subtitle="내가 결재할 수 있는 구성원 휴가 신청"
          foot="반려 시에도 신청자에게 알림이 전송됩니다"
        >
          <div className="table-wrap" role="region" aria-label="승인 대기 목록" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>신청자</th>
                  <th>유형</th>
                  <th>기간</th>
                  <th className="num">일수</th>
                  <th>업무대행</th>
                  <th>상태</th>
                  <th>처리</th>
                </tr>
              </thead>
              <tbody>
                {reviewLeaves.map((leave) => (
                  <tr key={leave.id}>
                    <td>{memberName(leave.member_id)}</td>
                    <td>{LEAVE_KIND_LABELS[leave.kind] ?? leave.kind}</td>
                    <td>{leave.start_on} ~ {leave.end_on}</td>
                    <td className="num">{leave.days}</td>
                    <td>{leave.substitute_id ? memberName(leave.substitute_id) : "—"}</td>
                    <td>
                      <Badge tone={STATUS_TONE[leave.status] ?? "neutral"}>
                        {STATUS_LABELS[leave.status] ?? leave.status}
                      </Badge>
                    </td>
                    <td>
                      {leave.status === "pending" ? (
                        <div className="leave-list__actions">
                          <Button
                            size="small"
                            disabled={decidingId === leave.id}
                            onClick={() => void decide(leave.id, "approve")}
                          >
                            승인
                          </Button>
                          <Button
                            tone="danger"
                            size="small"
                            disabled={decidingId === leave.id}
                            onClick={() => void decide(leave.id, "reject")}
                          >
                            반려
                          </Button>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="전사 휴가 달력"
        subtitle={`${shownYear}년 ${shownMonth + 1}월 · 구성원 ${new Set(calendarItems.map((leave) => leave.member_id)).size}명`}
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
        {calendarItems.length === 0 ? (
          <p className="attendance-empty">이 달에 등록된 휴가가 없습니다.</p>
        ) : (
          <MonthCalendar
            year={shownYear}
            month={shownMonth}
            {...(monthOffset === 0 ? { today: now.getDate() } : {})}
            events={leaveEventsOf(calendarItems, shownYear, shownMonth)}
          />
        )}
      </SectionCard>
      </>
      )}
    </div>
  );
}
