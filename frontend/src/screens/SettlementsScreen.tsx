import { Icon } from "../components/ui/Icon";
import { STL_TONE, demoSettlements } from "./mockup/demo";
import { Empty, PageHead, Pill, won } from "./mockup/lib";

// FIN-005 정산·지출요청 — 목업 settlements 이식
export function SettlementsScreen() {
  return (
    <>
      <PageHead
        title="정산·지출요청"
        id="FIN-005"
        fr="SFR-013 · SER-003"
        desc="영수증을 올리면 AI가 금액·일자·상호를 추출합니다. 추출값은 원본과 대조해 사람이 확인해야 제출할 수 있고, 제출된 원증빙은 수정·삭제할 수 없습니다."
      />
      <div className="grid g2">
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="upload" />
              정산 신청
            </h2>
          </div>
          <div className="panel-b stack">
            <div className="file-drop">
              <Icon name="upload" />
              <b>영수증 파일을 끌어 놓거나 선택하세요</b>
              <span className="hint">
                JPEG·PNG·PDF · 파일당 10MiB · 최대 5개/합계 25MiB · 암호화 PDF 거부 · 미리보기 없음
              </span>
              <div className="row">
                <label className="btn btn-sm">파일 선택</label>
                <button type="button" className="btn btn-sm btn-ai">
                  <Icon name="sparkles" />
                  샘플 영수증 사용
                </button>
              </div>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="clock" />
              정산 현황
            </h2>
            <span className="muted xs">조직 전체</span>
          </div>
          <div className="list">
            {demoSettlements.length ? (
              demoSettlements.map((s) => (
                <div className="li" style={{ alignItems: "flex-start" }} key={s.id}>
                  <div className="li-t">
                    <b>{s.title}</b>
                    <small>
                      {s.vendor} · {s.date} · {s.by}
                    </small>
                    <ul className="timeline" style={{ marginTop: 8 }}>
                      {s.timeline.map((t, i) => (
                        <li className="tl-i" key={i}>
                          <span className={`tl-dot ${t.state}`}>
                            <Icon name={t.state === "bad" ? "x" : t.label.includes("전표") ? "receipt" : "check"} />
                          </span>
                          <div className="tl-t">
                            {t.label}
                            {t.sub && <small>{t.sub}</small>}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="row">
                      <button type="button" className="btn btn-xs">
                        <Icon name="download" />
                        원증빙 다운로드
                      </button>
                    </div>
                  </div>
                  <div className="stack tight" style={{ justifyItems: "end" }}>
                    <span className="num b">{won(s.amount)}</span>
                    <Pill tone={STL_TONE[s.status]}>{s.status}</Pill>
                  </div>
                </div>
              ))
            ) : (
              <Empty title="정산 신청 내역이 없습니다" desc="왼쪽에서 영수증을 올려 첫 정산을 신청하세요." />
            )}
          </div>
        </section>
      </div>
    </>
  );
}
