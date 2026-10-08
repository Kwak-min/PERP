import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { demoHandovers } from "./mockup/demo";
import { Av, Empty, Meter, PageHead, Pill, fmtDate, pct } from "./mockup/lib";

// HND-001 인수인계 센터 — 목업 handover 이식
export function HandoverScreen() {
  const [selId, setSelId] = useState(
    demoHandovers.find((h) => h.status === "진행")?.id ?? demoHandovers[0]?.id ?? 0,
  );
  const sel = demoHandovers.find((h) => h.id === selId);
  const prog = sel
    ? pct(sel.items.filter((i) => i.done).length, sel.items.length)
    : 0;
  const kinds = sel ? [...new Set(sel.items.filter((i) => !i.sensitive).map((i) => i.kind))] : [];
  const sensitive = sel?.items.filter((i) => i.sensitive) ?? [];
  const editable = sel?.status !== "완료";

  return (
    <>
      <PageHead
        title="인수인계 센터"
        id="HND-001"
        fr="SFR-019"
        desc="담당자가 바뀌어도 문서·계정·자산·반복업무가 남도록 패키지로 넘깁니다. 민감·고기밀 항목은 자동으로 제외해 별도 대면 인계로 돌립니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="plus" />새 패키지 (자동 수집)
          </button>
        }
      />
      <div className="grid g-main" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)" }}>
        <section className="panel" style={{ alignSelf: "start" }}>
          <div className="panel-h">
            <h2>패키지</h2>
          </div>
          <div className="list">
            {demoHandovers.length ? (
              demoHandovers.map((h) => {
                const p = pct(h.items.filter((i) => i.done).length, h.items.length);
                return (
                  <button
                    type="button"
                    key={h.id}
                    className={`li pop-i${sel?.id === h.id ? " on" : ""}`}
                    onClick={() => setSelId(h.id)}
                  >
                    <span className="li-t">
                      <b>{h.title}</b>
                      <small>
                        {h.status === "완료" ? "완료" : `기한 ${fmtDate(h.due)}`} · {p}%
                      </small>
                    </span>
                    <Pill tone={h.status === "완료" ? "ok" : "info"}>{h.status}</Pill>
                  </button>
                );
              })
            ) : (
              <Empty title="인수인계 패키지가 없습니다" />
            )}
          </div>
        </section>
        {sel && (
          <section className="panel">
            <div className="panel-h">
              <h2>{sel.title}</h2>
              <Pill tone={sel.status === "완료" ? "ok" : "info"}>{sel.status}</Pill>
            </div>
            <div className="panel-b stack loose">
              <div className="row gap">
                <div className="row">
                  <Av name={sel.from} />
                  <div>
                    <b>{sel.from}</b>
                    <div className="muted xs">인계자</div>
                  </div>
                </div>
                <Icon name="right" />
                <div className="row">
                  <Av name={sel.to} />
                  <div>
                    <b>{sel.to}</b>
                    <div className="muted xs">인수자</div>
                  </div>
                </div>
                <span className="grow" />
                <div style={{ width: 180 }}>
                  <div className="row between xs">
                    <span>완료율</span>
                    <b>{prog}%</b>
                  </div>
                  <Meter p={prog} tone={prog === 100 ? "ok" : ""} />
                </div>
              </div>

              {kinds.map((k) => (
                <div key={k}>
                  <div className="sec-t">{k}</div>
                  <div className="stack tight">
                    {sel.items
                      .filter((i) => i.kind === k && !i.sensitive)
                      .map((i) => (
                        <label className="check" key={i.id}>
                          <input type="checkbox" defaultChecked={i.done} disabled={!editable} />{" "}
                          <span
                            style={
                              i.done
                                ? { textDecoration: "line-through", color: "var(--of-text-muted)" }
                                : undefined
                            }
                          >
                            {i.label}
                          </span>
                        </label>
                      ))}
                  </div>
                </div>
              ))}

              {sensitive.length > 0 && (
                <div className="callout warn">
                  <Icon name="lock" />
                  <div>
                    <b>자동 제외 {sensitive.length}건 — 별도 대면 인계</b>
                    <br />
                    {sensitive.map((i) => (
                      <span key={i.id}>
                        {i.label} <span className="muted xs">({i.kind})</span>
                        <br />
                      </span>
                    ))}
                    <span className="hint">
                      개인·민감·고기밀 등급은 패키지·AI 요약·내보내기에 포함되지 않습니다.
                    </span>
                  </div>
                </div>
              )}

              <div className="row gap">
                <div className="stack tight grow">
                  <b className="sm">양측 전자확인</b>
                  <span className="muted xs">
                    체크리스트 100% 이후 인계자·인수자가 각각 확인하면 완료됩니다.
                  </span>
                </div>
                <button
                  type="button"
                  className={`btn ${sel.fromOk ? "" : "btn-primary"}`}
                  disabled={sel.fromOk}
                >
                  {sel.fromOk ? "✓ 인계자 확인됨" : "인계자 확인"}
                </button>
                <button
                  type="button"
                  className={`btn ${sel.toOk ? "" : "btn-primary"}`}
                  disabled={sel.toOk}
                >
                  {sel.toOk ? "✓ 인수자 확인됨" : "인수자 확인"}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
