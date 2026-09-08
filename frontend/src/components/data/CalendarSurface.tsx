import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams, useNavigate } from "react-router-dom";
import { z } from "zod";
import type { ScreenDefinition } from "../../routes/catalog";
import { ApiError, apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { useSession } from "../../store/session";
import { StateBoundary } from "../common/StateBoundary";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { SectionCard } from "../ui/SectionCard";
import { CalendarCreateModal } from "./CalendarCreateModal";
import { MonthCalendar } from "./MonthCalendar";
import { calendarCells, calendarRecordsForDate, calendarRecordSchema, localDateInput, monthWindow, parseCalendarRecords, type CalendarRecord } from "./calendarModel";
import "./calendar-surface.css";

const permissionsSchema = z.object({ permissions: z.array(z.string()) });
const workspacesSchema = z.object({ organizations: z.array(permissionsSchema.extend({ org_id: z.string() })) });
type CalendarState = Readonly<{ status: "loading" | "ready" | "error" | "forbidden"; records: readonly CalendarRecord[]; error: Error | null }>;

export function CalendarSurface({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo<ApiSession | null>(() => stored ? { token: stored.token, orgId: stored.orgId } : null, [stored]);
  return session ? <CalendarWorkspace key={session.orgId} screen={screen} session={session} /> : null;
}

function CalendarWorkspace({ screen, session }: Readonly<{ screen: ScreenDefinition; session: ApiSession }>) {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const requestedMonth = search.get("month");
  const today = new Date();
  const shown = requestedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)
    ? new Date(`${requestedMonth}-01T00:00:00`) : new Date(today.getFullYear(), today.getMonth(), 1);
  const window = monthWindow(shown);
  const pg = isPgWorkspace(session.orgId);
  const endpoint = eventId ? (pg ? `/pg/calendar?event_id=${encodeURIComponent(eventId)}` : `/calendar/${encodeURIComponent(eventId)}`)
    : `${pg ? "/pg/calendar" : "/calendar"}?${new URLSearchParams(window)}`;
  const [state, setState] = useState<CalendarState>({ status: "loading", records: [], error: null });
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [revision, setRevision] = useState(0);
  const [modal, setModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", records: [], error: null });
    apiRequest(endpoint, { session, signal: controller.signal }).then(payload => {
      const records = eventId && !pg ? [calendarRecordSchema.parse(payload)] : parseCalendarRecords(payload, pg);
      if (!controller.signal.aborted) setState({ status: "ready", records, error: null });
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setState({ status: caught instanceof ApiError && caught.status === 403 ? "forbidden" : "error", records: [], error: caught instanceof Error ? caught : new Error("일정을 불러오지 못했습니다") });
    });
    return () => controller.abort();
  }, [endpoint, eventId, pg, revision, session]);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest(pg ? "/pg/auth/workspace" : "/tenants/current", { session, signal: controller.signal }).then(payload => {
      const next = pg ? workspacesSchema.parse(payload).organizations.find(org => org.org_id === session.orgId)?.permissions ?? [] : permissionsSchema.parse(payload).permissions;
      if (!controller.signal.aborted) setPermissions(next);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setNotice(`작업 권한을 확인하지 못했습니다: ${userMessageOf(caught)}`);
    });
    return () => controller.abort();
  }, [pg, session]);

  const cells = calendarCells(state.records, shown);
  const detail = state.records[0];
  const canWrite = permissions.includes('event.write') || (!pg && permissions.includes('*'));
  async function cancelEvent(): Promise<void> {
    if (!detail || !globalThis.confirm('일정을 취소할까요? 변경 이력은 보관됩니다.')) return;
    setCancelling(true); setNotice(null);
    try {
      await apiRequest(`${pg ? '/pg' : ''}/calendar/${encodeURIComponent(detail.id)}/cancel`, { session, method: 'POST', body: { version: detail.version } });
      navigate(`/calendar?${calendarQuery}`);
    } catch (caught: unknown) { setNotice(userMessageOf(caught)); }
    finally { setCancelling(false); }
  }
  const currentMonth = today.getFullYear() === shown.getFullYear() && today.getMonth() === shown.getMonth();
  const month = localDateInput(shown).slice(0, 7);
  const requestedDay = search.get("day");
  const parsedDay = requestedDay && /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) ? new Date(`${requestedDay}T00:00:00`) : null;
  const selected = parsedDay && localDateInput(parsedDay) === requestedDay && requestedDay?.slice(0, 7) === month
    ? parsedDay : currentMonth ? today : shown;
  const selectedDate = localDateInput(selected);
  const selectedEvents = calendarRecordsForDate(state.records, selected);
  const calendarQuery = new URLSearchParams({ month, day: selectedDate }).toString();
  function changeMonth(date: Date): void { setSearch({ month: localDateInput(date).slice(0, 7), day: localDateInput(date) }); }
  const daysWithEvents = new Set(cells.map(event => event.day)).size;
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const upcoming = [...state.records]
    .filter(event => Date.parse(event.start_at) >= todayStart)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.id.localeCompare(b.id))
    .slice(0, 6);
  const todayCount = calendarRecordsForDate(state.records, today).length;
  return <div className="screen calendar-screen" data-screen-id={screen.id}>
    <header className="screen-header"><div><div className="screen-header__meta"><Badge>{screen.id}</Badge><Badge>calendar</Badge></div><h1>{screen.label}</h1><p>{screen.description}</p></div>
      <div className="screen-header__actions">{eventId ? <><Link className="button button--neutral" to={`/calendar?${calendarQuery}`}>캘린더로</Link><Button disabled={!canWrite || !detail?.version || cancelling} onClick={() => setModal(true)}>일정 수정</Button><Button tone="danger" disabled={!canWrite || !detail?.version || cancelling} onClick={() => void cancelEvent()}>일정 취소</Button></>
        : <Button disabled={!(permissions.includes("event.write") || (!pg && permissions.includes("*")))} onClick={() => setModal(true)}>새로 만들기</Button>}</div></header>
    {notice && <div className="screen-notice" role="status"><span>{notice}</span><Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button></div>}
    <div className={eventId ? "" : "calendar-body"}>
    <SectionCard title={eventId ? "일정 상세" : "월간 일정"} subtitle={`기기 시간대: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`} foot="권한 범위 안의 서버 일정만 표시합니다">
      {!eventId && <nav className="calendar-nav" aria-label="월 선택"><Button tone="neutral" size="small" aria-label="이전 달" onClick={() => changeMonth(new Date(shown.getFullYear(), shown.getMonth() - 1, 1))}>이전</Button>
        <strong aria-live="polite">{shown.getFullYear()}년 {shown.getMonth() + 1}월</strong><Button tone="neutral" size="small" aria-label="다음 달" onClick={() => changeMonth(new Date(shown.getFullYear(), shown.getMonth() + 1, 1))}>다음</Button>
        <Button tone="neutral" size="small" onClick={() => changeMonth(today)}>오늘</Button></nav>}
      <StateBoundary status={state.status} error={state.error}>
        {eventId ? detail ? <dl className="kv-list"><div><dt>이름</dt><dd>{detail.title}</dd></div><div><dt>시작</dt><dd>{new Date(detail.start_at).toLocaleString("ko-KR")}</dd></div><div><dt>종료</dt><dd>{new Date(detail.end_at).toLocaleString("ko-KR")}</dd></div><div><dt>장소</dt><dd>{detail.location ?? "미지정"}</dd></div></dl> : <p role="status">일정을 찾을 수 없습니다.</p>
          : <><MonthCalendar year={shown.getFullYear()} month={shown.getMonth()} events={cells} selectedDay={selected.getDate()}
              onSelectDay={day => setSearch({ month, day: localDateInput(new Date(shown.getFullYear(), shown.getMonth(), day)) }, { replace: true })}
              {...(currentMonth ? { today: today.getDate() } : {})} />
            {state.status === "ready" && cells.length === 0 && <p className="calendar-empty" role="status">이번 달에 등록된 일정이 없습니다.</p>}
            <section id="calendar-selected-day" className="calendar-selected-day" data-date={selectedDate} aria-labelledby="calendar-selected-day-title">
              <h3 id="calendar-selected-day-title" aria-live="polite">{selected.getFullYear()}년 {selected.getMonth() + 1}월 {selected.getDate()}일 일정 ({selectedEvents.length}건)</h3>
              {selectedEvents.length === 0 ? <p className="calendar-empty" role="status">선택한 날짜에 등록된 일정이 없습니다.</p>
                : <ul className="calendar-day-list">{selectedEvents.map(event => <li key={event.id}>
                  <Link className="calendar-day-list__event" to={`/calendar/${encodeURIComponent(event.id)}?${calendarQuery}`}>
                    <strong>{event.title}</strong>
                    <span><time dateTime={event.start_at}>{new Date(event.start_at).toLocaleString("ko-KR")}</time> ~ <time dateTime={event.end_at}>{new Date(event.end_at).toLocaleString("ko-KR")}</time></span>
                  </Link>
                </li>)}</ul>}
            </section></>}
      </StateBoundary>
    </SectionCard>
    {!eventId && state.status === "ready" && <aside className="calendar-summary" aria-label="일정 요약">
      <SectionCard title="이번 달 요약" subtitle={`${shown.getFullYear()}년 ${shown.getMonth() + 1}월`}>
        <dl className="calendar-summary__stats">
          <div><dt>총 일정</dt><dd>{state.records.length}건</dd></div>
          <div><dt>일정 있는 날</dt><dd>{daysWithEvents}일</dd></div>
          {currentMonth && <div><dt>오늘 일정</dt><dd>{todayCount}건</dd></div>}
        </dl>
      </SectionCard>
      <SectionCard title="다가오는 일정" subtitle="오늘 이후 예정된 일정">
        {upcoming.length === 0 ? <p className="calendar-empty" role="status">예정된 일정이 없습니다.</p>
          : <ul className="calendar-upcoming">{upcoming.map(event => <li key={event.id}>
            <Link className="calendar-upcoming__item" to={`/calendar/${encodeURIComponent(event.id)}?${calendarQuery}`}>
              <span className="calendar-upcoming__date">{new Date(event.start_at).toLocaleDateString("ko-KR", { month: "short", day: "numeric", weekday: "short" })}</span>
              <strong>{event.title}</strong>
              <span className="calendar-upcoming__time">{new Date(event.start_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}{event.location ? ` · ${event.location}` : ""}</span>
            </Link>
          </li>)}</ul>}
      </SectionCard>
    </aside>}
    </div>
    {modal && <CalendarCreateModal session={session} {...(eventId && detail ? { initialEvent: detail } : {})} shown={selected} onClose={() => setModal(false)} onSaved={start => {
      setModal(false); changeMonth(start); setRevision(value => value + 1); setNotice("일정을 서버에 저장했습니다.");
    }} />}
  </div>;
}
