import { Icon } from "../components/ui/Icon";
import {
  RES_H0,
  RES_H1,
  demoReservations,
  demoResources,
  myReservations,
} from "./mockup/demo";
import { Empty, PageHead, Pill, fmtDate } from "./mockup/lib";

const pos = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return ((h + m / 60 - RES_H0) / (RES_H1 - RES_H0)) * 100;
};

// AST-003 공간·장비 예약 — 목업 reservations 이식
export function ReservationsScreen() {
  const day = "2026-09-14";
  const hours = Array.from({ length: RES_H1 - RES_H0 + 1 }, (_, i) => RES_H0 + i);

  return (
    <>
      <PageHead
        title="공간·장비 예약"
        id="AST-003"
        fr="SFR-015"
        desc="같은 자원의 시간이 겹치는 예약은 DB 제약(tsrange GiST exclusion)으로 동시에 들어와도 한 건만 성공합니다. 겹치면 대기열에 올릴 수 있습니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="plus" />
            예약
          </button>
        }
      />
      <div className="filters">
        <button type="button" className="icon-btn" aria-label="전날">
          <Icon name="left" />
        </button>
        <input type="date" defaultValue={day} aria-label="날짜" style={{ width: 160 }} />
        <button type="button" className="icon-btn" aria-label="다음날">
          <Icon name="right" />
        </button>
        <button type="button" className="btn btn-sm">
          오늘
        </button>
        <span className="muted sm">{fmtDate(day)}</span>
      </div>
      <div className="panel tbl-wrap">
        <div className="gantt">
          <div className="g-row head">
            <div className="g-lbl">자원</div>
            <div className="g-days">
              {hours.map((h) => (
                <span key={h} style={{ left: `${((h - RES_H0) / (RES_H1 - RES_H0)) * 100}%` }}>
                  {h}
                </span>
              ))}
            </div>
          </div>
          {demoResources.map((r) => (
            <div className="g-row" key={r.id}>
              <div className="g-lbl">
                <b className="sm">{r.name}</b>
                <span className="muted xs">
                  {r.kind} · {r.meta}
                </span>
              </div>
              <div className="g-track tall">
                {hours.map((h) => (
                  <i
                    className="g-grid"
                    key={h}
                    style={{ left: `${((h - RES_H0) / (RES_H1 - RES_H0)) * 100}%` }}
                  />
                ))}
                {demoReservations
                  .filter((x) => x.resourceId === r.id)
                  .map((x) => (
                    <button
                      type="button"
                      key={x.id}
                      className={`res-blk${
                        x.status === "대기"
                          ? " wait"
                          : x.status === "체크인"
                            ? " in"
                            : x.mine
                              ? " mine"
                              : ""
                      }`}
                      style={{ left: `${pos(x.start)}%`, width: `${pos(x.end) - pos(x.start)}%` }}
                      title={`${x.title} · ${x.start}~${x.end} · ${x.user} · ${x.status}`}
                    >
                      {x.status === "대기" ? "대기 · " : ""}
                      {x.title}
                      <small>
                        {x.start}–{x.end} {x.user}
                      </small>
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="legend" style={{ marginTop: 10 }}>
        <span>
          <i style={{ background: "var(--of-primary)" }} />내 예약
        </span>
        <span>
          <i style={{ background: "var(--primary-soft)" }} />
          다른 사람 예약
        </span>
        <span>
          <i style={{ background: "color-mix(in srgb,var(--of-success) 18%,transparent)" }} />
          체크인
        </span>
        <span>
          <i style={{ boxShadow: "inset 0 0 0 1.5px var(--border-strong)" }} />
          대기열
        </span>
      </div>
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <h2>
            <Icon name="clock" />내 예약
          </h2>
        </div>
        <div className="list">
          {myReservations.length ? (
            myReservations.map((x, i) => (
              <div className="li" key={i}>
                <span className="agenda-time">
                  {fmtDate(x.date)}
                  <br />
                  {x.start}–{x.end}
                </span>
                <span className="li-t">
                  <b>{x.title}</b>
                  <small>{x.resource}</small>
                </span>
                <Pill tone={x.status === "대기" ? "warn" : x.status === "체크인" ? "ok" : "info"}>
                  {x.status}
                </Pill>
                {x.status === "확정" && (
                  <button type="button" className="btn btn-xs">
                    체크인
                  </button>
                )}
                <button type="button" className="btn btn-xs btn-ghost">
                  취소
                </button>
              </div>
            ))
          ) : (
            <Empty title="예정된 예약이 없습니다" />
          )}
        </div>
      </section>
    </>
  );
}
