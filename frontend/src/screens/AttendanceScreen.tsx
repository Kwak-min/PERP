import { Icon } from "../components/ui/Icon";
import {
  attCorrections,
  myAttendance,
  teamAttendance,
} from "./mockup/demo";
import { Av, Empty, PageHead, Pill, fmtDate } from "./mockup/lib";

const hoursMin = (m: number) => `${Math.floor(m / 60)}시간 ${Math.round(m % 60)}분`;

// HR-002 근태 기록 — 목업 attendance 이식
export function AttendanceScreen() {
  const totalMin = myAttendance.reduce((a, r) => a + r.minutes, 0);
  const today = myAttendance[0];

  return (
    <>
      <PageHead
        title="근태 기록"
        id="HR-002"
        fr="SFR-016"
        desc="조직 유형(학생회)에 맞춰 '근태'으로 표시합니다. 같은 날 중복 체크인은 막힙니다."
      />
      <div className="grid g-main">
        <div className="stack">
          <section className="panel">
            <div className="panel-h">
              <h2>
                <Icon name="clock" />
                오늘 · {fmtDate("2026-09-14")}
              </h2>
              <Pill tone="ok">종료</Pill>
            </div>
            <div className="panel-b row gap">
              <div className="grow">
                <b>{today?.kind}</b>
                <p className="muted sm">
                  시작 {today?.in} · 종료 {today?.out} · {today?.minutes}분
                </p>
              </div>
              <button type="button" className="btn btn-primary">
                시작 (체크인)
              </button>
              <button type="button" className="btn" disabled>
                종료 (체크아웃)
              </button>
            </div>
          </section>
          <section className="panel">
            <div className="panel-h">
              <h2>
                <Icon name="calendar" />
                2026년 9월 내 기록
              </h2>
              <div className="row">
                <button type="button" className="icon-btn sm" aria-label="이전 달">
                  <Icon name="left" />
                </button>
                <button type="button" className="icon-btn sm" aria-label="다음 달">
                  <Icon name="right" />
                </button>
              </div>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>종류</th>
                    <th>시작</th>
                    <th>종료</th>
                    <th className="num">시간</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {myAttendance.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDate(r.date)}</td>
                      <td>{r.kind}</td>
                      <td className="tnum">{r.in}</td>
                      <td className="tnum">{r.out ?? "-"}</td>
                      <td className="num">{r.out ? hoursMin(r.minutes) : "-"}</td>
                      <td>
                        <button type="button" className="btn btn-xs btn-ghost">
                          수정 요청
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>합계 {myAttendance.length}회</td>
                    <td className="num">{Math.round(totalMin / 60)}시간</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="panel">
            <div className="panel-h">
              <h2>
                <Icon name="users" />
                오늘 팀 현황
              </h2>
              <span className="muted xs">인사 보기 권한</span>
            </div>
            <div className="list">
              {teamAttendance.map((t) => (
                <div className="li" key={t.name}>
                  <Av name={t.name} size="sm" />
                  <span className="li-t">
                    <b>{t.name}</b>
                    <small>
                      {t.kind ? `${t.kind} · ${t.in}~${t.out ?? ""}` : "기록 없음"}
                    </small>
                  </span>
                  {t.status && (
                    <Pill tone={t.status === "종료" ? "ok" : "info"}>{t.status}</Pill>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-h">
              <h2>
                <Icon name="edit" />
                수정 요청
              </h2>
            </div>
            <div className="list">
              {attCorrections.length ? (
                attCorrections.map((c, i) => (
                  <div className="li" key={i}>
                    <span className="li-t">
                      <b>
                        {c.name} · {fmtDate(c.date)}
                      </b>
                      <small>{c.text}</small>
                    </span>
                    {c.status === "대기" ? (
                      <button type="button" className="btn btn-xs btn-primary">
                        승인
                      </button>
                    ) : (
                      <Pill tone="ok">{c.status}</Pill>
                    )}
                  </div>
                ))
              ) : (
                <Empty title="수정 요청이 없습니다" />
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
