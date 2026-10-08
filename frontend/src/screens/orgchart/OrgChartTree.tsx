import { useState } from "react";

import { seatLabel, type OrgSeat } from "./model";

type TreeProps = Readonly<{
  roots: readonly OrgSeat[];
  selectedMemberId: string | null;
  selectedSeatId: string | null;
  busy: boolean;
  canSetup: boolean;
  canAdd: boolean;
  onSelectMember: (membershipId: string) => void;
  onSetupSeat: (seat: OrgSeat) => void;
  onAddChild: (seat: OrgSeat, name: string) => void;
}>;

function SeatCard({
  seat,
  depth,
  ...handlers
}: Readonly<{ seat: OrgSeat; depth: number }> & Omit<TreeProps, "roots">) {
  const { selectedMemberId, selectedSeatId, busy, canSetup, canAdd, onSelectMember, onSetupSeat, onAddChild } = handlers;
  const [adding, setAdding] = useState(false);
  const [childName, setChildName] = useState("");
  const locked = !seat.configured || !seat.leader;

  return (
    <li className="orgchart__item" aria-label={`${seat.name} ${seatLabel(seat)}`}>
      {depth > 0 && <span className="orgchart__connector" aria-hidden="true" />}
      <article
        className={[
          "orgchart__seat",
          depth === 0 ? "orgchart__seat--root" : "",
          locked ? "orgchart__seat--locked" : "",
          seat.id === selectedSeatId ? "orgchart__seat--active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className="orgchart__avatar" aria-hidden="true">
          {locked ? "🔒" : seat.leader?.name.slice(0, 1)}
        </span>
        <div className="orgchart__body">
          <div className="orgchart__identity">
            {locked ? (
              <b className="orgchart__unset">설정</b>
            ) : (
              <button
                type="button"
                className={
                  seat.leader?.membership_id === selectedMemberId
                    ? "orgchart__name orgchart__name--on"
                    : "orgchart__name"
                }
                onClick={() => seat.leader && onSelectMember(seat.leader.membership_id)}
              >
                {seat.leader?.name}
              </button>
            )}
            <span>{locked ? "책임자 미지정" : (seat.leader?.title ?? "직책 미지정")}</span>
          </div>
          <span className="orgchart__department">{seat.name}</span>
          {locked ? (
            <p className="orgchart__lock-note">책임자가 지정되지 않은 부서입니다.</p>
          ) : (
            <div className="orgchart__permissions" aria-label="책임자 역할">
              {seat.leader?.roles.map(role => <span key={role} className="orgchart__permission">{role}</span>)}
            </div>
          )}
          {seat.members.length > 0 && (
            <div className="orgchart__members">
              {seat.members.map((member) => (
                <button
                  key={member.membership_id}
                  type="button"
                  className={
                    member.membership_id === selectedMemberId
                      ? "orgchart__chip orgchart__chip--on"
                      : "orgchart__chip"
                  }
                  onClick={() => onSelectMember(member.membership_id)}
                >
                  {member.name}
                  {member.title ? ` · ${member.title}` : ""}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="orgchart__count">{seat.member_count}명</span>
      </article>

      {(canSetup || canAdd) && <div className="orgchart__actions">
        {canSetup && <button type="button" className={locked ? "orgchart__setup" : "orgchart__reassign"} disabled={busy} onClick={() => onSetupSeat(seat)}>{locked ? "이 자리 설정" : "인원 배치"}</button>}
        {canAdd && <button type="button" className="orgchart__add" aria-expanded={adding} disabled={busy} onClick={() => setAdding(value => !value)}><span aria-hidden="true">+</span> 하위 부서 추가</button>}
      </div>}

      {adding && canAdd && (
        <form
          className="orgchart__add-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (childName.trim() === "") return;
            onAddChild(seat, childName.trim());
            setChildName("");
            setAdding(false);
          }}
        >
          <label>
            <span>{seat.name} 아래 새 자리 이름</span>
            <input
              value={childName}
              onChange={(event) => setChildName(event.target.value)}
              placeholder="예: 디자인팀"
              autoFocus
            />
          </label>
          <div className="orgchart__add-form-actions">
            <button type="button" onClick={() => { setAdding(false); setChildName(""); }}>
              취소
            </button>
            <button type="submit" disabled={busy || childName.trim() === ""}>
              {busy ? "만드는 중…" : "자리 만들기"}
            </button>
          </div>
          <p>새 자리는 책임자를 지정할 때까지 잠긴 상태로 생깁니다.</p>
        </form>
      )}

      {seat.children.length > 0 && (
        <ul className="orgchart__children">
          {seat.children.map((child) => (
            <SeatCard key={child.id} seat={child} depth={depth + 1} {...handlers} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgChartTree({ roots, ...handlers }: TreeProps) {
  if (roots.length === 0) {
    return (
      <p className="orgchart__empty">
        아직 부서가 없습니다. 조직 설정에서 부서를 만들면 조직도에 자리가 생깁니다.
      </p>
    );
  }
  return (
    <div className="orgchart">
      <div className="orgchart__legend">
        <span>선은 보고·관리 관계를 나타냅니다.</span>
        <span>배지는 책임자에게 배정된 역할입니다. 직책은 권한을 부여하지 않습니다.</span>
        <span>🔒 표시는 책임자 미지정 부서입니다.</span>
      </div>
      <ul className="orgchart__root" aria-label="조직 구조">
        {roots.map((seat) => (
          <SeatCard key={seat.id} seat={seat} depth={0} {...handlers} />
        ))}
      </ul>
    </div>
  );
}
