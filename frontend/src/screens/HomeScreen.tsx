import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { orgDepts, orgKpi, orgMonthly, orgRisks } from "./mockup/demo";
import { Empty, Meter, MonthlyChart, PageHead, Pill, StatTile, pct, won } from "./mockup/lib";

// DASH-002 조직 대시보드 — 목업 renderOrgDashboard() 이식
export function HomeScreen() {
  const k = orgKpi;
  return (
    <>
      <PageHead
        title="조직 대시보드"
        id="DASH-002"
        fr="SFR-006"
        desc="권한이 있는 지표만 표시합니다. 모든 지표에 산식과 갱신 시각을 함께 적습니다."
        actions={
          <>
            <select aria-label="부서 필터" defaultValue="">
              <option value="">전체 부서</option>
              {orgDepts.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn">
              <Icon name="download" />
              CSV
            </button>
          </>
        }
      />
      <div className="stats" style={{ marginBottom: 16 }}>
        <StatTile label="진행 중 프로젝트" value={`${k.activeProjects}개`} sub="산식: 상태=진행" />
        <StatTile
          label="업무 완료율"
          value={`${pct(k.tasksDone, k.tasksTotal)}%`}
          sub={`완료 ${k.tasksDone} / 전체 ${k.tasksTotal}`}
        />
        <StatTile
          label="기한 초과 업무"
          value={`${k.overdue}건`}
          sub="마감일 < 오늘 · 미완료"
          tone={k.overdue ? "warn" : ""}
        />
        <StatTile
          label="예산 집행률"
          value={`${k.budgetRate}%`}
          sub={`확정 지출 ${won(k.budgetUsed)} / 승인예산 ${won(k.budgetTotal)}`}
        />
        <StatTile
          label="회비 납부율"
          value={`${k.duesRate}%`}
          sub={`${k.duesPaid}건 납부 / 대상 ${k.duesTarget}건 (면제 제외)`}
        />
      </div>

      <div className="grid g-main">
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="chart" />
              월별 수입·지출
            </h2>
            <span className="muted xs">확정 전표 기준</span>
          </div>
          <div className="panel-b">
            <MonthlyChart data={orgMonthly} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="alert" />
              위험 신호
            </h2>
            <span className={`pill ${orgRisks.length ? "warn" : "ok"}`}>{orgRisks.length}건</span>
          </div>
          <div className="list">
            {orgRisks.length ? (
              orgRisks.slice(0, 8).map((r, i) => (
                <Link className="li" to={r.href} key={i}>
                  <Pill tone={r.lv === "높음" ? "bad" : "warn"}>{r.lv}</Pill>
                  <span className="li-t">
                    <b>{r.text}</b>
                    <small>{r.sub}</small>
                  </span>
                </Link>
              ))
            ) : (
              <Empty title="위험 신호가 없습니다" />
            )}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <h2>
            <Icon name="users" />
            부서별 현황
          </h2>
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>부서</th>
                <th className="num">인원</th>
                <th className="num">진행 업무</th>
                <th className="num">완료</th>
                <th>완료율</th>
                <th className="num">기한 초과</th>
              </tr>
            </thead>
            <tbody>
              {orgDepts.map((d) => {
                const total = d.active + d.done;
                return (
                  <tr key={d.name}>
                    <td className="t-title">{d.name}</td>
                    <td className="num">{d.people}</td>
                    <td className="num">{d.active}</td>
                    <td className="num">{d.done}</td>
                    <td style={{ minWidth: 140 }}>
                      <div className="row">
                        <Meter p={pct(d.done, total)} />
                        <span className="xs num">{pct(d.done, total)}%</span>
                      </div>
                    </td>
                    <td className="num">
                      {d.overdue ? <span className="ink-bad b">{d.overdue}</span> : "0"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
