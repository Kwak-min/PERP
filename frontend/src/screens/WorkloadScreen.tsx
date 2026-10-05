import { useMemo } from "react";

import { Av, Empty, Meter, PageHead, Pill } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Load = { assignee_id: string; open: number; hours: number; overload: boolean };
type Member = { user_id: string; name: string; title: string | null };

// TSK-005 업무량·자원배정 — 실제 백엔드(/tasks/workload/summary) 연동
export function WorkloadScreen() {
  const res = useApi<{ items: Load[] }>("/tasks/workload/summary");
  const memberRes = useApi<{ items: Member[] }>("/members");

  const rows = useMemo(() => {
    const info = new Map((memberRes.data?.items ?? []).map((m) => [m.user_id, m]));
    return (res.data?.items ?? [])
      .map((l) => ({ ...l, member: info.get(l.assignee_id) }))
      .filter((r) => r.member)
      .sort((a, b) => b.open - a.open);
  }, [res.data, memberRes.data]);

  const max = Math.max(1, ...rows.map((r) => r.open));

  return (
    <>
      <PageHead
        title="업무량·자원배정"
        id="TSK-005"
        fr="SFR-008"
        desc="구성원별 미완료 업무 수입니다. 3건 이상이면 과부하로 표시합니다."
      />
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>구성원</th>
              <th style={{ width: "50%" }}>진행 중 업무</th>
              <th className="num">건수</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {res.loading ? (
              <tr>
                <td colSpan={4}>
                  <Empty title="불러오는 중…" icon="clock" />
                </td>
              </tr>
            ) : rows.length ? (
              rows.map((r) => (
                <tr key={r.assignee_id}>
                  <td className="nowrap">
                    <Av name={r.member!.name} size="sm" /> {r.member!.name}
                    {r.member!.title && <span className="sub">{r.member!.title}</span>}
                  </td>
                  <td>
                    <Meter p={(r.open / max) * 100} tone={r.overload || r.open >= 3 ? "bad" : ""} />
                  </td>
                  <td className="num b">{r.open}</td>
                  <td>
                    {r.overload || r.open >= 3 ? (
                      <Pill tone="bad">과부하</Pill>
                    ) : r.open >= 2 ? (
                      <Pill tone="warn">주의</Pill>
                    ) : (
                      <Pill tone="ok">여유</Pill>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>
                  <Empty title="업무량 데이터가 없습니다" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="legend" style={{ marginTop: 10 }}>
        <span>
          <i style={{ background: "var(--of-success)" }} />여유 (0~1건)
        </span>
        <span>
          <i style={{ background: "var(--of-warning)" }} />주의 (2건)
        </span>
        <span>
          <i style={{ background: "var(--of-danger)" }} />과부하 (3건 이상)
        </span>
      </div>
    </>
  );
}
