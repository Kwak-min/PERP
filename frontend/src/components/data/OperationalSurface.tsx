import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { z } from "zod";

import type { ScreenDefinition } from "../../routes/catalog";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { QuickCreateModal } from "../common/QuickCreateModal";
import { StateBoundary } from "../common/StateBoundary";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { SectionCard } from "../ui/SectionCard";
import { KanbanBoard, type KanbanColumn } from "./KanbanBoard";
import { MonthCalendar, type CalendarEvent } from "./MonthCalendar";

const taskSchema = z.object({ id: z.string(), title: z.string(), status: z.string(), priority: z.string(), due_at: z.string().nullable(), assignee_id: z.string().nullable(), version: z.number() });
const tasksSchema = z.object({ items: z.array(taskSchema) });
const boardSchema = z.object({ columns: z.array(z.object({ status: z.string(), wip_limit: z.number(), items: z.array(taskSchema) })) });
const eventSchema = z.object({ id: z.string(), title: z.string(), start_at: z.string(), end_at: z.string(), location: z.string().nullable(), calendar: z.string(), version: z.number() });
const eventsSchema = z.object({ items: z.array(eventSchema) });
const stepSchema = z.object({ approver_id: z.string(), status: z.string() });
const approvalSchema = z.object({ id: z.string(), title: z.string(), status: z.string(), amount: z.number(), requester_id: z.string(), steps: z.array(stepSchema) });
const approvalsSchema = z.object({ items: z.array(approvalSchema), box: z.string() });
const duesSchema = z.object({ items: z.array(z.object({ id: z.string(), payer_id: z.string(), amount_minor: z.number(), due_on: z.string(), status: z.string() })), payment_rate: z.number() });
const membersSchema = z.object({ items: z.array(z.object({ user_id: z.string(), name: z.string(), email: z.string() })) });
const organizationSchema = z.object({ permissions: z.array(z.string()) });

type Kind = "task" | "calendar" | "approval" | "dues";
type LoadState = "loading" | "ready" | "empty" | "error";
const LABELS: Readonly<Record<string, string>> = { todo: "할 일", in_progress: "진행 중", review: "검토", done: "완료", pending: "대기", approved: "승인", rejected: "반려", paid: "납부", exempt: "면제" };

function kindOf(screenId: string): Kind | null {
  if (screenId.startsWith("TSK-")) return "task";
  if (screenId.startsWith("CAL-")) return "calendar";
  if (screenId === "APR-001") return "approval";
  if (screenId === "FIN-004") return "dues";
  return null;
}

export function isOperationalScreen(screenId: string): boolean {
  return kindOf(screenId) !== null;
}

export function OperationalSurface({ screen, session }: Readonly<{ screen: ScreenDefinition; session: ApiSession }>) {
  const params = useParams();
  const kind = kindOf(screen.id);
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const [modal, setModal] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [members, setMembers] = useState<readonly Readonly<{ id: string; label: string }>[]>([]);
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const taskId = params.taskId;
  const eventId = params.eventId;
  const can = (permission: string): boolean => permissions.includes("*") || permissions.includes(permission);
  const endpoint = screen.id === "TSK-002" ? "/tasks/board" : taskId ? `/tasks/${encodeURIComponent(taskId)}` : eventId ? `/calendar/${encodeURIComponent(eventId)}` : screen.endpoint;

  useEffect(() => {
    if (!endpoint) return;
    const controller = new AbortController();
    setState("loading"); setError(null);
    apiRequest(endpoint, { session, signal: controller.signal }).then((payload) => {
      if (controller.signal.aborted) return;
      setData(payload);
      const empty = payload && typeof payload === "object" && "items" in payload && Array.isArray(payload.items) && payload.items.length === 0;
      setState(empty && kind !== "calendar" ? "empty" : "ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught : new Error("Unknown error")); setState("error");
    });
    return () => controller.abort();
  }, [endpoint, kind, revision, session]);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest("/tenants/current", { session, signal: controller.signal }).then((payload) => {
      if (!controller.signal.aborted) setPermissions(organizationSchema.parse(payload).permissions);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setNotice(`작업 권한을 확인하지 못했습니다: ${userMessageOf(caught)}`);
    });
    return () => controller.abort();
  }, [session]);

  useEffect(() => {
    if (kind !== "approval" && kind !== "dues") return;
    const controller = new AbortController();
    apiRequest("/members?limit=500", { session, signal: controller.signal }).then((payload) => {
      const parsed = membersSchema.parse(payload);
      if (!controller.signal.aborted) setMembers(parsed.items.map((member) => ({ id: member.user_id, label: `${member.name} (${member.email})` })));
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setNotice(`구성원 선택 목록을 불러오지 못했습니다: ${userMessageOf(caught)}`);
    });
    return () => controller.abort();
  }, [kind, session]);

  async function mutate(path: string, body: unknown, method: "POST" | "PATCH" = "POST"): Promise<void> {
    try {
      await apiRequest(path, { method, session, body });
      setNotice("변경 내용을 서버에 저장했습니다."); setRevision((value) => value + 1);
    } catch (caught: unknown) {
      setNotice(userMessageOf(caught));
    }
  }

  const body = useMemo(() => {
    if (state !== "ready") return null;
    if (screen.id === "TSK-002") {
      const parsed = boardSchema.parse(data);
      const columns: readonly KanbanColumn[] = parsed.columns.map((column) => ({ key: column.status, label: LABELS[column.status] ?? column.status, limit: column.wip_limit,
        cards: column.items.map((task) => ({ title: task.title, assignee: task.assignee_id ? "담당" : "미지정", ...(task.due_at ? { due: task.due_at.slice(0, 10) } : {}), priority: task.priority === "high" ? "high" : "normal" })) }));
      return <KanbanBoard columns={columns} />;
    }
    if (kind === "task" && taskId) {
      const task = taskSchema.parse(data);
      return <dl className="kv-list"><div><dt>이름</dt><dd>{task.title}</dd></div><div><dt>상태</dt><dd>{LABELS[task.status] ?? task.status}</dd></div><div><dt>우선순위</dt><dd>{task.priority}</dd></div><div><dt>마감</dt><dd>{task.due_at ?? "미지정"}</dd></div></dl>;
    }
    if (kind === "task") return <ul className="operational-list">{tasksSchema.parse(data).items.map((task) => <li key={task.id}><Link to={`/tasks/${task.id}`}>{task.title}</Link><Badge>{LABELS[task.status] ?? task.status}</Badge>{task.status !== "done" && can("task.write") && <Button size="small" tone="neutral" onClick={() => void mutate(`/tasks/${task.id}`, { status: "done", version: task.version }, "PATCH")}>완료</Button>}</li>)}</ul>;
    if (kind === "calendar" && eventId) {
      const event = eventSchema.parse(data);
      return <dl className="kv-list"><div><dt>이름</dt><dd>{event.title}</dd></div><div><dt>시작</dt><dd>{new Date(event.start_at).toLocaleString("ko-KR")}</dd></div><div><dt>종료</dt><dd>{new Date(event.end_at).toLocaleString("ko-KR")}</dd></div><div><dt>장소</dt><dd>{event.location ?? "미지정"}</dd></div></dl>;
    }
    if (kind === "calendar") {
      const today = new Date();
      const shown = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
      const records = eventsSchema.parse(data).items;
      const events: readonly CalendarEvent[] = records.filter((event) => { const date = new Date(event.start_at); return date.getFullYear() === shown.getFullYear() && date.getMonth() === shown.getMonth(); }).map((event) => { const date = new Date(event.start_at); return { day: date.getDate(), time: date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }), title: event.title }; });
      return <><div className="calendar-nav"><Button tone="neutral" size="small" aria-label="이전 달" onClick={() => setMonthOffset((value) => value - 1)}>이전</Button><strong>{shown.getFullYear()}년 {shown.getMonth() + 1}월</strong><Button tone="neutral" size="small" aria-label="다음 달" onClick={() => setMonthOffset((value) => value + 1)}>다음</Button></div>
        <MonthCalendar year={shown.getFullYear()} month={shown.getMonth()} {...(monthOffset === 0 ? { today: today.getDate() } : {})} events={events} />
        {events.length > 0 && <ul className="operational-list calendar-event-list">{records.filter((event) => { const date = new Date(event.start_at); return date.getFullYear() === shown.getFullYear() && date.getMonth() === shown.getMonth(); }).map((event) => <li key={event.id}><Link to={`/calendar/${event.id}`}>{event.title}</Link><time>{new Date(event.start_at).toLocaleString("ko-KR")}</time></li>)}</ul>}</>;
    }
    if (kind === "approval") return <ul className="operational-list">{approvalsSchema.parse(data).items.map((approval) => <li key={approval.id}><strong>{approval.title}</strong><Badge>{LABELS[approval.status] ?? approval.status}</Badge>{approval.status === "pending" && can("approval.decide") && <><Button size="small" onClick={() => void mutate(`/approvals/requests/${approval.id}/actions`, { decision: "approve" })}>승인</Button><Button size="small" tone="danger" onClick={() => void mutate(`/approvals/requests/${approval.id}/actions`, { decision: "reject" })}>반려</Button></>}</li>)}</ul>;
    if (kind === "dues") return <ul className="operational-list dues-list">{duesSchema.parse(data).items.map((charge) => <li key={charge.id}><strong>{charge.amount_minor.toLocaleString("ko-KR")}원</strong><span>{members.find((member) => member.id === charge.payer_id)?.label ?? `납부자 ${charge.payer_id}`}</span><span>납부기한 {charge.due_on}</span><Badge>{LABELS[charge.status] ?? charge.status}</Badge>{charge.status !== "paid" && can("dues.write") && <Button size="small" onClick={() => void mutate(`/finance/dues/charges/${charge.id}/pay`, { amount_minor: charge.amount_minor, paid_on: new Date().toISOString().slice(0, 10) })}>납부 처리</Button>}</li>)}</ul>;
    return null;
  }, [data, eventId, kind, members, monthOffset, permissions, state, taskId]);

  if (!kind || !endpoint) return null;
  const canCreate = (kind === "task" && !taskId && screen.id !== "TSK-002" && can("task.write")) || (kind === "calendar" && !eventId && can("event.write")) || (kind === "approval" && can("approval.request")) || (kind === "dues" && can("dues.write"));
  return <div className="screen" data-screen-id={screen.id}><header className="screen-header"><div><div className="screen-header__meta"><Badge>{screen.id}</Badge><Badge>{screen.module}</Badge></div><h1>{screen.label}</h1><p>{screen.description}</p></div><div className="screen-header__actions"><Button disabled={!canCreate} title={canCreate ? "서버에 새 항목을 저장합니다" : "이 화면에서는 새 항목을 만들 수 없습니다"} onClick={() => setModal(true)}>새로 만들기</Button></div></header>
    {notice && <div className="screen-notice" role="status"><span>{notice}</span><Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button></div>}
    <SectionCard title={screen.id === "TSK-002" ? "업무 보드" : screen.label} subtitle="서버에 저장된 최신 데이터" foot="서버 응답만 표시합니다"><StateBoundary status={state} error={error} emptyTitle={`아직 ${screen.label} 항목이 없습니다`} emptyDescription="새 항목을 만들면 여기에 표시됩니다.">{body}</StateBoundary></SectionCard>
    {modal && <QuickCreateModal entityLabel={screen.label} kind={kind} session={session} options={members} onClose={() => setModal(false)} onSaved={(name) => { setModal(false); setNotice(`${name} 항목을 서버에 저장했습니다.`); setRevision((value) => value + 1); }} />}
  </div>;
}
