import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { MemberDetailPanel } from "./orgchart/MemberDetailPanel";
import { OrgChartTree } from "./orgchart/OrgChartTree";
import { SeatSetupPanel } from "./orgchart/SeatSetupPanel";
import {
  flattenSeats,
  membersSchema,
  orgChartSchema,
  type OrgChart,
  type OrgMember,
  type OrgSeat,
} from "./orgchart/model";

import "./orgchart.css";

export function OrgChartScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const [chart, setChart] = useState<OrgChart | null>(null);
  const [members, setMembers] = useState<readonly OrgMember[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [setupSeat, setSetupSeat] = useState<OrgSeat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );

  const reload = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    try {
      const [chartData, memberData] = await Promise.all([
        apiRequest("/pg/members/org-chart", { session: apiSession }),
        apiRequest("/pg/members?limit=200", { session: apiSession }),
      ]);
      setChart(orgChartSchema.parse(chartData));
      setMembers(membersSchema.parse(memberData).items);
      setError(null);
    } catch (caught) {
      setError(userMessageOf(caught));
    }
  }, [apiSession]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const seats = useMemo(() => (chart ? flattenSeats(chart.roots) : []), [chart]);
  const selectedMember = members.find((member) => member.membership_id === selectedMemberId) ?? null;
  const departmentNameOf = (member: OrgMember): string =>
    seats.find((seat) => seat.id === member.department_id)?.name ?? "미배정";

  async function saveSeat(input: Readonly<{ leaderUserId: string | null; assigned: readonly string[] }>): Promise<void> {
    if (!apiSession || !setupSeat) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/pg/members/departments/${setupSeat.id}`, {
        method: "PATCH",
        session: apiSession,
        body: { leader_id: input.leaderUserId },
      });
      const before = new Set(setupSeat.members.map((member) => member.membership_id));
      const after = new Set(input.assigned);
      const changes = members.filter(
        (member) =>
          (after.has(member.membership_id) && !before.has(member.membership_id)) ||
          (!after.has(member.membership_id) && before.has(member.membership_id)),
      );
      for (const member of changes) {
        await apiRequest(`/pg/members/${member.membership_id}/assignment`, {
          method: "PATCH",
          session: apiSession,
          body: { department_id: after.has(member.membership_id) ? setupSeat.id : null },
        });
      }
      setSetupSeat(null);
      setNotice(`${setupSeat.name} 자리를 설정했습니다.`);
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function changeTitle(member: OrgMember, title: string): Promise<void> {
    if (!apiSession) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/pg/members/${member.membership_id}/assignment`, {
        method: "PATCH",
        session: apiSession,
        body: { title },
      });
      setNotice(`${member.name} 직책을 ${title}(으)로 변경했습니다.`);
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function addChild(seat: OrgSeat, name: string): Promise<void> {
    if (!apiSession || name.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/pg/members/departments", {
        method: "POST",
        session: apiSession,
        body: { name: name.trim(), parent_id: seat.id },
      });
      setNotice(`${name.trim()} 자리를 만들었습니다. 아직 설정하지 않아 잠겨 있습니다.`);
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const lockedCount = seats.filter((seat) => !seat.configured).length;

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">사람</span>
            <Badge>{screen.id}</Badge>
            {lockedCount > 0 && <Badge tone="warning">미설정 {lockedCount}자리</Badge>}
          </div>
          <h1>{screen.label}</h1>
          <p>{screen.description}</p>
        </div>
        <div className="screen-header__actions">
          <Link className="button button--neutral button--small" to="/org-log">
            변경 로그
          </Link>
          <Button tone="neutral" size="small" disabled={busy} onClick={() => void reload()}>
            새로 고침
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

      <div className="orgchart-layout">
        <SectionCard title="조직도" subtitle="부서 구조와 책임자" foot="괄호 표기는 공석입니다">
          {chart === null ? (
            <p className="orgchart__empty">조직도를 불러오는 중입니다…</p>
          ) : (
            <OrgChartTree
              roots={chart.roots}
              selectedMemberId={selectedMemberId}
              selectedSeatId={setupSeat?.id ?? null}
              onSelectMember={(membershipId) => {
                setSelectedMemberId(membershipId);
                setSetupSeat(null);
              }}
              onSetupSeat={(seat) => {
                setSetupSeat(seat);
                setSelectedMemberId(null);
              }}
              busy={busy}
              onAddChild={(seat, name) => void addChild(seat, name)}
            />
          )}
          {chart !== null && chart.unassigned.length > 0 && (
            <div className="orgchart__unassigned">
              <h3>미배정 인원 {chart.unassigned.length}명</h3>
              <div className="orgchart__members">
                {chart.unassigned.map((member) => (
                  <button
                    key={member.membership_id}
                    type="button"
                    className={
                      member.membership_id === selectedMemberId
                        ? "orgchart__chip orgchart__chip--on"
                        : "orgchart__chip"
                    }
                    onClick={() => setSelectedMemberId(member.membership_id)}
                  >
                    {member.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </SectionCard>

        <aside className="orgchart-aside">
          {setupSeat ? (
            <SeatSetupPanel
              seat={setupSeat}
              members={members}
              busy={busy}
              onCancel={() => setSetupSeat(null)}
              onSave={(input) => void saveSeat(input)}
            />
          ) : selectedMember ? (
            <MemberDetailPanel
              member={selectedMember}
              departmentName={departmentNameOf(selectedMember)}
              busy={busy}
              onChangeTitle={(member, title) => void changeTitle(member, title)}
            />
          ) : (
            <p className="orgchart__hint">
              이름을 누르면 이메일·부서·전화번호와 직책 조정이 여기에 표시됩니다.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
