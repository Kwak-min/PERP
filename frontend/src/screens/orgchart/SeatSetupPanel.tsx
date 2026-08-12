import { useMemo, useState } from "react";

import { Button } from "../../components/ui/Button";
import type { OrgMember, OrgSeat } from "./model";

type Props = Readonly<{
  seat: OrgSeat;
  members: readonly OrgMember[];
  busy: boolean;
  onCancel: () => void;
  onSave: (input: Readonly<{ leaderUserId: string | null; assigned: readonly string[] }>) => void;
}>;

/**
 * 자리 설정 = 책임자 지정 + 인원 배치.
 * 왼쪽(대기 인원) → 오른쪽(이 자리) 흐름으로 배치 결과를 보여준다.
 */
export function SeatSetupPanel({ seat, members, busy, onCancel, onSave }: Props) {
  const [leaderUserId, setLeaderUserId] = useState(seat.leader_id ?? "");
  const [assigned, setAssigned] = useState<readonly string[]>(
    seat.members.map((member) => member.membership_id),
  );

  const pool = useMemo(
    () => members.filter((member) => !assigned.includes(member.membership_id)),
    [members, assigned],
  );
  const placed = useMemo(
    () => members.filter((member) => assigned.includes(member.membership_id)),
    [members, assigned],
  );

  function move(membershipId: string, into: boolean): void {
    setAssigned((current) =>
      into
        ? [...current, membershipId]
        : current.filter((id) => id !== membershipId),
    );
  }

  return (
    <section className="seat-setup" aria-label={`${seat.name} 자리 설정`}>
      <header className="seat-setup__head">
        <div>
          <span className="eyebrow">SEAT SETUP</span>
          <h2>{seat.name} 자리 설정</h2>
          <p>책임자를 지정하면 잠금이 풀립니다. 아래에서 이 자리에 배치할 인원을 옮기세요.</p>
        </div>
        <Button tone="neutral" size="small" onClick={onCancel}>닫기</Button>
      </header>

      <label className="seat-setup__leader">
        책임자
        <select value={leaderUserId} onChange={(event) => setLeaderUserId(event.target.value)}>
          <option value="">— 선택하세요 —</option>
          {members.map((member) => (
            <option key={member.user_id} value={member.user_id}>
              {member.name}
              {member.title ? ` · ${member.title}` : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="seat-flow">
        <div className="seat-flow__column">
          <h3>대기 인원 {pool.length}명</h3>
          <ul>
            {pool.map((member) => (
              <li key={member.membership_id}>
                <span>
                  <b>{member.name}</b>
                  <small>{member.title ?? "직책 미지정"}</small>
                </span>
                <button type="button" onClick={() => move(member.membership_id, true)}>
                  배치 →
                </button>
              </li>
            ))}
            {pool.length === 0 && <li className="seat-flow__empty">대기 인원이 없습니다</li>}
          </ul>
        </div>
        <div className="seat-flow__arrow" aria-hidden="true">→</div>
        <div className="seat-flow__column seat-flow__column--target">
          <h3>{seat.name} {placed.length}명</h3>
          <ul>
            {placed.map((member) => (
              <li key={member.membership_id}>
                <span>
                  <b>{member.name}</b>
                  <small>{member.user_id === leaderUserId ? "책임자" : (member.title ?? "직책 미지정")}</small>
                </span>
                <button type="button" onClick={() => move(member.membership_id, false)}>
                  ← 해제
                </button>
              </li>
            ))}
            {placed.length === 0 && <li className="seat-flow__empty">배치된 인원이 없습니다</li>}
          </ul>
        </div>
      </div>

      <div className="seat-setup__actions">
        <Button tone="neutral" onClick={onCancel}>취소</Button>
        <Button
          disabled={busy || leaderUserId === ""}
          onClick={() => onSave({ leaderUserId: leaderUserId || null, assigned })}
        >
          {busy ? "저장 중…" : "설정 저장"}
        </Button>
      </div>
    </section>
  );
}
