import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";

import { CreateFormModal } from "../components/common/CreateFormModal";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { screens, type ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf, type ApiSession } from "../services/api";
import { isPgWorkspace } from "../services/workspace";
import { useSession } from "../store/session";
import { MemberDetailPanel } from "./orgchart/MemberDetailPanel";
import { MemberDirectory } from "./orgchart/MemberDirectory";
import { OrgChartTree } from "./orgchart/OrgChartTree";
import { OrgLogModal } from "./orgchart/OrgLogModal";
import { SeatSetupPanel } from "./orgchart/SeatSetupPanel";
import { flattenSeats, membersSchema, orgChartSchema, type OrgChart, type OrgMember, type OrgSeat } from "./orgchart/model";
import "./orgchart.css";

const permissionsSchema = z.object({ permissions: z.array(z.string()) });
type DataState = Readonly<{ status: "loading" | "ready" | "error"; chart: OrgChart | null; members: readonly OrgMember[]; error: string | null }>;

export function OrgChartScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo(() => stored?.orgId ? { token: stored.token, orgId: stored.orgId } : null, [stored?.token, stored?.orgId]);
  // 조직/로그인 변경 시 이전 조직의 행·선택·열린 팝업을 함께 폐기한다.
  return session ? <OrganizationWorkspace key={`${session.orgId}:${session.token}`} screen={screen} session={session} /> : null;
}

function OrganizationWorkspace({ screen, session }: Readonly<{ screen: ScreenDefinition; session: ApiSession }>) {
  const pg = isPgWorkspace(session.orgId);
  const [search, setSearch] = useSearchParams();
  const [state, setState] = useState<DataState>({ status: "loading", chart: null, members: [], error: null });
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [permissionState, setPermissionState] = useState("loading");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [setupSeat, setSetupSeat] = useState<OrgSeat | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const can = (permission: string) => permissions.includes(permission) || (!pg && permissions.includes("*"));
  const canAssign = can(pg ? "department.write" : "member.write");
  const canSetup = can("department.write") && canAssign;
  const canReadLog = can(pg ? "audit.read" : "member.read");
  const createConfig = screens.find(item => item.id === "ORG-002")?.create;

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", chart: null, members: [], error: null });
    Promise.all([
      apiRequest("/pg/members/org-chart", { session, signal: controller.signal }),
      apiRequest("/pg/members?limit=1000", { session, signal: controller.signal }),
    ]).then(([chartData, memberData]) => {
      const chart = orgChartSchema.parse(chartData), members = membersSchema.parse(memberData).items;
      if (!controller.signal.aborted) setState({ status: "ready", chart, members, error: null });
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setState({ status: "error", chart: null, members: [], error: userMessageOf(caught) });
    });
    return () => controller.abort();
  }, [session, revision]);

  useEffect(() => {
    const controller = new AbortController();
    setPermissions([]); setPermissionState("loading"); setPermissionError(null);
    apiRequest("/settings/access", { session, signal: controller.signal }).then(payload => {
      const grants = permissionsSchema.parse(payload).permissions;
      if (!controller.signal.aborted) { setPermissions(grants); setPermissionState("ready"); }
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) { setPermissionError(`작업 권한을 확인하지 못했습니다: ${userMessageOf(caught)}`); setPermissionState("error"); }
    });
    return () => controller.abort();
  }, [session, revision]);

  useEffect(() => {
    const refresh = () => { setSetupSeat(null); setRevision(value => value + 1); };
    window.addEventListener("orbitflow:access-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("orbitflow:access-changed", refresh); window.removeEventListener("focus", refresh); };
  }, []);

  const requestedLog = search.get("org-log") === "1";
  useEffect(() => {
    if (requestedLog && canReadLog) {
      document.getElementById("org-log-trigger")?.focus();
      setShowLog(true);
    }
  }, [requestedLog, canReadLog]);
  function closeLog(): void {
    setShowLog(false);
    if (requestedLog) { const next = new URLSearchParams(search); next.delete("org-log"); setSearch(next, { replace: true }); }
  }
  const seats = useMemo(() => state.chart ? flattenSeats(state.chart.roots) : [], [state.chart]);
  const selectedMember = state.members.find(member => member.membership_id === selectedMemberId) ?? null;
  function selectMember(id: string): void { setSelectedMemberId(id); setSetupSeat(null); }
  function reload(): void { setSetupSeat(null); setRevision(value => value + 1); }

  async function saveSeat(input: Readonly<{ leaderUserId: string | null; assigned: readonly string[] }>): Promise<void> {
    if (!setupSeat) return;
    setBusy(true); setMutationError(null);
    try {
      await apiRequest(`/pg/members/departments/${setupSeat.id}`, { method: "PATCH", session, body: { leader_id: input.leaderUserId } });
      const before = new Set(setupSeat.members.map(member => member.membership_id)), after = new Set(input.assigned);
      for (const member of state.members.filter(member => after.has(member.membership_id) !== before.has(member.membership_id))) {
        await apiRequest(`/pg/members/${member.membership_id}/assignment`, { method: "PATCH", session, body: { department_id: after.has(member.membership_id) ? setupSeat.id : null } });
      }
      setNotice(`${setupSeat.name} 자리를 설정했습니다.`);
    } catch (caught) {
      setMutationError(`일부 변경이 적용되었을 수 있습니다. 새 상태를 확인하세요. ${userMessageOf(caught)}`);
    } finally { setBusy(false); reload(); }
  }
  async function changeTitle(member: OrgMember, title: string): Promise<void> {
    setBusy(true); setMutationError(null);
    try {
      await apiRequest(`/pg/members/${member.membership_id}/assignment`, { method: "PATCH", session, body: { title } });
      setNotice(`${member.name} 직책을 ${title}(으)로 변경했습니다.`); reload();
    } catch (caught) { setMutationError(userMessageOf(caught)); }
    finally { setBusy(false); }
  }
  async function addChild(seat: OrgSeat, name: string): Promise<void> {
    setBusy(true); setMutationError(null);
    try {
      await apiRequest("/pg/members/departments", { method: "POST", session, body: { name: name.trim(), parent_id: seat.id } });
      setNotice(`${name.trim()} 부서를 만들었습니다.`); reload();
    } catch (caught) { setMutationError(userMessageOf(caught)); }
    finally { setBusy(false); }
  }
  return <div className="screen org-unified" data-screen-id={screen.id} data-org-state={state.status} data-org-permissions={permissionState}>
    <header className="screen-header"><div><div className="screen-header__meta"><span className="eyebrow">사람</span><Badge>{screen.id}</Badge></div><h1>구성원·조직도</h1><p>구성원과 부서 구조를 함께 확인하고 관리합니다.</p></div>
      <div className="screen-header__actions">
        {pg && createConfig && can("member.write") && can("role.assign") && <Button size="small" onClick={() => setShowCreate(true)}>구성원 추가</Button>}
        <Button tone="neutral" size="small" id="org-log-trigger" aria-haspopup="dialog" aria-controls="org-log-dialog" aria-expanded={showLog} disabled={!canReadLog} onClick={() => setShowLog(true)}>변경 로그</Button>
        <Button tone="neutral" size="small" disabled={busy || state.status === "loading"} onClick={reload}>새로 고침</Button>
      </div>
    </header>
    {permissionError && <div className="form-error" role="alert">{permissionError}</div>}
    {requestedLog && permissionState === "ready" && !canReadLog && <div className="form-error" role="alert">조직 변경 로그를 볼 권한이 없습니다.</div>}
    {mutationError && <div className="form-error" role="alert">{mutationError}</div>}
    {notice && <div className="screen-notice" role="status"><span>{notice}</span><Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button></div>}
    {state.status === "loading" ? <p className="orgchart__empty" role="status">구성원과 조직도를 불러오는 중입니다…</p>
      : state.error ? <div className="form-error" role="alert">{state.error}</div>
      : <div className="orgchart-layout"><div className="orgchart-main">
        <MemberDirectory members={state.members} seats={seats} selectedMemberId={selectedMemberId} initialQuery={search.get("q") ?? ""} onSelect={selectMember} />
        <SectionCard title="조직도" subtitle="부서 구조와 책임자" foot="직접 등록한 부서만 표시합니다">
          <OrgChartTree roots={state.chart?.roots ?? []} selectedMemberId={selectedMemberId} selectedSeatId={setupSeat?.id ?? null} onSelectMember={selectMember} onSetupSeat={seat => { setSetupSeat(seat); setSelectedMemberId(null); }} busy={busy} canSetup={canSetup} canAdd={can("department.write")} onAddChild={(seat, name) => void addChild(seat, name)} />
          {Boolean(state.chart?.unassigned.length) && <div className="orgchart__unassigned"><h3>미배정 인원 {state.chart?.unassigned.length}명</h3><div className="orgchart__members">{state.chart?.unassigned.map(member => <button key={member.membership_id} type="button" className={member.membership_id === selectedMemberId ? "orgchart__chip orgchart__chip--on" : "orgchart__chip"} onClick={() => selectMember(member.membership_id)}>{member.name}</button>)}</div></div>}
        </SectionCard>
      </div><aside className="orgchart-aside" aria-live="polite">
        {setupSeat && canSetup ? <SeatSetupPanel key={setupSeat.id} seat={setupSeat} members={state.members.filter(member => member.status === "active")} busy={busy} onCancel={() => setSetupSeat(null)} onSave={input => void saveSeat(input)} />
          : selectedMember ? <MemberDetailPanel member={selectedMember} departmentName={seats.find(seat => seat.id === selectedMember.department_id)?.name ?? selectedMember.department_id ?? "미배정"} busy={busy} canAssign={canAssign && selectedMember.status === "active"} session={session} onChangeTitle={(member, title) => void changeTitle(member, title)} />
          : <p className="orgchart__hint">목록이나 조직도에서 이름을 선택하면 이메일·부서·전화번호와 인사 프로필을 확인할 수 있습니다.</p>}
      </aside></div>}
    {showLog && canReadLog && <OrgLogModal session={session} onClose={closeLog} />}
    {showCreate && pg && createConfig && can("member.write") && can("role.assign") && <CreateFormModal entityLabel="구성원" config={createConfig} session={session} onClose={() => setShowCreate(false)} onCreated={() => { setNotice("구성원을 추가했습니다."); reload(); }} />}
  </div>;
}
