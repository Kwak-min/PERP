import { Icon } from "../components/ui/Icon";
import {
  LEAVE_LABEL,
  LEAVE_TONE,
  leaveKpi,
  myLeaves,
  teamLeaves,
  type DemoLeave,
} from "./mockup/demo";
import { Av, Empty, PageHead, Pill, StatTile, fmtDate } from "./mockup/lib";

// HR-003 휴가·부재 — 목업 leave 이식
export function LeaveScreen() {
  const { total, used, pending } = leaveKpi;
  const left = total - used - pending;
  const range = (l: DemoLeave) =>
    `${fmtDate(l.start)}${l.end !== l.start ? ` – ${fmtDate(l.end)}` : ""}`;

  return (
    <>
      <PageHead
        title="휴가·부재"
        id="HR-003"
        fr="SFR-016"
        desc="승인되면 캘린더와 업무량 화면에 자동 반영됩니다. 업무대행자를 지정할 수 있습니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="plus" />
            휴가 신청
          </button>
        }
      />
      <div className="stats" style={{ marginBottom: 16 }}>
        <StatTile label="부여" value={`${total}일`} sub="학기 기준" />
        <StatTile label="사용" value={`${used}일`} />
        <StatTile label="결재 중" value={`${pending}일`} />
        <StatTile label="잔여" value={`${left}일`} sub="결재 중 포함 차감" tone={left <= 1 ? "warn" : ""} />
      </div>
      <div className="grid g2">
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="umbrella" />내 신청
            </h2>
          </div>
          <div className="list">
            {myLeaves.length ? (
              myLeaves.map((l, i) => (
                <div className="li" key={i}>
                  <span className="li-t">
                    <b>
                      {l.type} · {l.days}일
                    </b>
                    <small>
                      {range(l)} · {l.reason}
                      {l.delegate ? ` · 대행 ${l.delegate}` : ""}
                    </small>
                  </span>
                  <Pill tone={LEAVE_TONE[l.status]}>{LEAVE_LABEL[l.status]}</Pill>
                </div>
              ))
            ) : (
              <Empty title="신청 내역이 없습니다" />
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="calendar" />팀 휴가 일정
            </h2>
          </div>
          <div className="list">
            {teamLeaves.length ? (
              teamLeaves.map((l, i) => (
                <div className="li" key={i}>
                  <Av name={l.user ?? ""} size="sm" />
                  <span className="li-t">
                    <b>{l.user}</b>
                    <small>
                      {range(l)} · {l.days}일
                    </small>
                  </span>
                  <Pill tone={LEAVE_TONE[l.status]}>{LEAVE_LABEL[l.status]}</Pill>
                </div>
              ))
            ) : (
              <Empty title="예정된 부재가 없습니다" />
            )}
          </div>
        </section>
      </div>
    </>
  );
}
