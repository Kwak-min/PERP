import { Icon } from "../components/ui/Icon";
import { Empty, Meter, PageHead, Pill, num } from "./mockup/lib";

const RETENTION: Array<{ label: string; period: string; action: string; hold: boolean; always?: boolean }> = [
  { label: "업무·프로젝트", period: "3년", action: "익명화 후 통계만 보존", hold: false },
  { label: "회계 전표·예산", period: "5년 (법정)", action: "원본 보존 후 파기", hold: true },
  { label: "정산 원증빙", period: "5년 (법정)", action: "암호화 보관 후 파기", hold: false },
  { label: "회원 개인정보", period: "탈퇴 시 즉시", action: "익명화 (이력 보존)", hold: false },
  { label: "감사 로그", period: "영구", action: "append-only, 파기 불가", hold: true, always: true },
];

const JOBS: Array<{ scope: string; format: string; rows: number; by: string; at: string; status: "done" | "running" | "failed"; expires?: string; progress?: number }> = [
  { scope: "회계 (전표·예산·회비)", format: "CSV", rows: 1240, by: "김경준", at: "9.10 14:20", status: "done", expires: "9.11 14:20" },
  { scope: "회원 목록 (마스킹)", format: "CSV", rows: 18, by: "김경준", at: "9.8 09:10", status: "done", expires: "9.9 09:10" },
  { scope: "감사로그 5년치 (시뮬레이션)", format: "JSON", rows: 128400, by: "김경준", at: "9.12 16:30", status: "failed" },
];

// ADM-004 데이터 보존·내보내기 — 목업 data 이식
export function DataScreen() {
  return (
    <>
      <PageHead
        title="데이터 보존·내보내기"
        id="ADM-004"
        fr="SFR-030 · DAR-008 · PER-006"
        desc="내보내기는 비동기 작업으로 만들고, 파일은 암호화되며 링크는 24시간 뒤 만료됩니다. 100,000행을 넘으면 조용히 자르지 않고 413으로 거부합니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="download" />
            내보내기 작업
          </button>
        }
      />
      <div className="grid g2">
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="clock" />
              보존 정책
            </h2>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>데이터</th>
                  <th>보존</th>
                  <th>파기 방식</th>
                  <th>법적 보존</th>
                </tr>
              </thead>
              <tbody>
                {RETENTION.map((r) => (
                  <tr key={r.label}>
                    <td className="t-title">{r.label}</td>
                    <td>{r.period}</td>
                    <td className="muted xs">{r.action}</td>
                    <td>
                      <label className="check">
                        <input type="checkbox" defaultChecked={r.hold} disabled={r.always} />{" "}
                        {r.always ? "항상" : r.hold ? "적용" : ""}
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="download" />
              내보내기 작업
            </h2>
          </div>
          <div className="list">
            {JOBS.length ? (
              JOBS.map((j, i) => (
                <div className="li" key={i}>
                  <span className="li-t">
                    <b>
                      {j.scope} · {j.format}
                    </b>
                    <small>
                      {num(j.rows)}행 · {j.by} · {j.at}
                      {j.status === "done" ? ` · 링크 만료 ${j.expires}` : ""}
                    </small>
                    {j.status === "running" && <Meter p={j.progress ?? 0} />}
                  </span>
                  {j.status === "done" ? (
                    <button type="button" className="btn btn-xs">
                      다운로드
                    </button>
                  ) : (
                    <Pill tone={j.status === "failed" ? "bad" : "info"}>
                      {j.status === "failed" ? "413 거부" : "진행 중"}
                    </Pill>
                  )}
                </div>
              ))
            ) : (
              <Empty title="작업이 없습니다" />
            )}
          </div>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <h2>
            <Icon name="users" />
            탈퇴 처리
          </h2>
        </div>
        <form className="panel-b inline-form" onSubmit={(e) => e.preventDefault()}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>회원</label>
            <select defaultValue="최우진">
              <option>최우진</option>
              <option>김민지</option>
            </select>
          </div>
          <button className="btn btn-danger" type="submit">
            탈퇴 처리 (익명화)
          </button>
          <p className="hint grow">
            이름·연락처·이메일을 익명화하고 업무·회계 이력은 보존합니다. 재인증과 영향 범위 확인 후 실행됩니다.
          </p>
        </form>
      </section>
    </>
  );
}
