import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { APPROVAL_KINDS } from "./mockup/demo";
import { ROLE_DEFS } from "./mockup/rbac";
import { PageHead, Pill, won } from "./mockup/lib";

type Step = { role: string; min: number };
type Form = { id: number; name: string; kind: keyof typeof APPROVAL_KINDS; version: number; steps: Step[]; reauthMin?: number; sla: number; inUse: number };

const FORMS: Form[] = [
  { id: 1, name: "지출결의 결재선", kind: "expense", version: 3, steps: [{ role: "treasurer", min: 0 }, { role: "president", min: 500000 }], reauthMin: 1000000, sla: 48, inUse: 2 },
  { id: 2, name: "정산 결재선", kind: "settlement", version: 2, steps: [{ role: "dept_head", min: 0 }, { role: "treasurer", min: 0 }], sla: 72, inUse: 1 },
  { id: 3, name: "휴가·불참 결재선", kind: "leave", version: 1, steps: [{ role: "dept_head", min: 0 }], sla: 24, inUse: 0 },
];

const roles = ROLE_DEFS.filter((r) => !["external", "member", "auditor"].includes(r.key));
const roleName = (key: string) => ROLE_DEFS.find((r) => r.key === key)?.name ?? key;

// APR-002 결재 양식·결재선 — 목업 approval-forms 이식
export function ApprovalFormsScreen() {
  const [selId, setSelId] = useState(1);
  const [amt, setAmt] = useState(450000);
  const f = FORMS.find((x) => x.id === selId) ?? FORMS[0]!;
  const preview = f.steps.filter((s) => amt >= (s.min || 0)).map((s) => roleName(s.role));

  return (
    <>
      <PageHead
        title="결재 양식·결재선"
        id="APR-002"
        fr="SFR-020"
        desc="조건부 결재선(금액 기준), 재인증 기준 금액, 처리 기한(SLA)을 양식별로 정합니다. 저장할 때마다 버전이 올라가고, 진행 중인 결재가 있는 양식은 삭제할 수 없습니다."
      />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,260px) minmax(0,1fr)" }}>
        <section className="panel" style={{ alignSelf: "start" }}>
          <div className="list">
            {FORMS.map((x) => (
              <button
                type="button"
                key={x.id}
                className={`li pop-i${x.id === f.id ? " on" : ""}`}
                onClick={() => setSelId(x.id)}
              >
                <span className="li-t">
                  <b>{x.name}</b>
                  <small>
                    {APPROVAL_KINDS[x.kind]} · v{x.version}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              {f.name} <span className="mono xs muted">v{f.version}</span>
            </h2>
            {f.inUse ? (
              <Pill tone="warn">진행 중 {f.inUse}건 · 삭제 불가</Pill>
            ) : (
              <Pill tone="muted">사용 중인 결재 없음</Pill>
            )}
          </div>
          <div className="panel-b stack loose">
            <div>
              <div className="sec-t">결재선 (순차)</div>
              <div className="stack tight">
                {f.steps.map((s, i) => (
                  <div className="row" key={i}>
                    <span className="trace-id">{i + 1}</span>
                    <select defaultValue={s.role} style={{ width: 200 }} aria-label="결재자 역할">
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <span className="sm">금액이</span>
                    <input
                      type="number"
                      min={0}
                      step={10000}
                      defaultValue={s.min || 0}
                      aria-label="최소 금액"
                      style={{ width: 140 }}
                    />
                    <span className="sm">원 이상일 때</span>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label="단계 삭제"
                      disabled={f.steps.length === 1}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-sm" style={{ justifySelf: "start" }}>
                  <Icon name="plus" />
                  단계 추가
                </button>
              </div>
            </div>
            <div className="form-grid" style={{ maxWidth: 520 }}>
              <div className="field">
                <label>재인증 기준 금액</label>
                <input type="number" min={0} step={100000} defaultValue={f.reauthMin ?? ""} placeholder="없음" />
              </div>
              <div className="field">
                <label>처리 기한 (시간)</label>
                <input type="number" min={1} defaultValue={f.sla} />
              </div>
            </div>
            <div className="callout info">
              <Icon name="eye" />
              <div className="stack tight grow">
                <div className="row">
                  <label className="b sm">결재선 미리보기 · 금액</label>
                  <input
                    type="number"
                    step={10000}
                    value={amt}
                    onChange={(e) => setAmt(+e.target.value || 0)}
                    style={{ width: 150 }}
                  />
                  <span className="sm">원 (요청자: 나)</span>
                </div>
                <div className="sm">
                  {preview.length ? (
                    preview.map((r, i) => (
                      <span key={i}>
                        {i > 0 ? " → " : ""}
                        <b>{r}</b>
                      </span>
                    ))
                  ) : (
                    "결재자 없음"
                  )}
                  {f.reauthMin && amt >= f.reauthMin && (
                    <>
                      {" · "}
                      <Pill tone="warn">재인증 필요</Pill>
                    </>
                  )}
                  {" · "}
                  <span className="muted">한도 {won(f.reauthMin ?? 0)}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
