import { Icon } from "../components/ui/Icon";
import { GradeChip, Meter, PageHead, Pill, num, pct } from "./mockup/lib";

const GRADES = ["공개", "내부", "개인", "민감", "고기밀"];
const GRADE_RANK: Record<string, number> = { 공개: 0, 내부: 1, 개인: 2, 민감: 3, 고기밀: 4 };
const ROUTES: Record<string, "openrouter" | "local" | "blocked"> = {
  공개: "openrouter",
  내부: "local",
  개인: "local",
  민감: "local",
  고기밀: "blocked",
};
const TOOLS: Array<[string, string, "low" | "medium" | "high"]> = [
  ["create_task", "업무 생성", "low"],
  ["draft_entry", "전표 초안 작성", "medium"],
  ["confirm_entry", "전표 확정 (회계 확정)", "high"],
  ["notify_unpaid", "미납자 알림 발송", "high"],
  ["delete_doc", "문서 삭제", "high"],
  ["change_role", "역할·권한 변경", "low"],
];
const ALLOW: Record<string, boolean> = {
  create_task: true,
  draft_entry: true,
  confirm_entry: false,
  notify_unpaid: false,
  delete_doc: false,
  change_role: false,
};
const RISK_LABEL: Record<string, string> = { low: "저위험", medium: "중위험", high: "고위험" };
const RISK_TONE: Record<string, string> = { low: "ok", medium: "warn", high: "bad" };

// ADM-003 AI 정책·모델 관리 — 목업 ai-policy 이식
export function AiPolicyScreen() {
  const external = false;
  const costUsed = 18400,
    costLimit = 30000;
  return (
    <>
      <PageHead
        title="AI 정책·모델 관리"
        id="ADM-003"
        fr="SFR-025 · SIR-005/006"
        desc="데이터 등급별로 어떤 모델을 쓸지 정합니다. 민감·고기밀은 외부 LLM으로 보낼 수 없습니다. 변경은 AI 평가를 통과해야 배포됩니다."
        actions={
          <>
            <button type="button" className="btn">
              <Icon name="play" />
              AI 평가 실행
            </button>
            <button type="button" className="btn btn-primary" disabled>
              정책 배포 (v4)
            </button>
          </>
        }
      />
      <div className="grid g2">
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="sliders" />
              데이터 등급 라우팅
            </h2>
            <label className="check">
              <input type="checkbox" defaultChecked={external} /> 외부 LLM 허용
            </label>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>등급</th>
                  <th>provider</th>
                  <th>외부 전송</th>
                </tr>
              </thead>
              <tbody>
                {GRADES.map((g) => (
                  <tr key={g}>
                    <td>
                      <GradeChip grade={g} />
                    </td>
                    <td>
                      <select defaultValue={ROUTES[g]} style={{ height: 30 }} aria-label={`${g} provider`}>
                        <option value="openrouter" disabled={(GRADE_RANK[g] ?? 0) >= 3}>
                          OpenRouter (외부)
                          {(GRADE_RANK[g] ?? 0) >= 3 ? " — 정책상 불가" : ""}
                        </option>
                        <option value="local">로컬 Ollama</option>
                        <option value="blocked">차단</option>
                      </select>
                    </td>
                    <td>
                      {ROUTES[g] === "openrouter" && external ? (
                        <Pill tone="info">허용</Pill>
                      ) : (
                        <Pill tone="muted">차단</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-b form-grid" style={{ borderTop: "1px solid var(--of-border)" }}>
            <div className="field">
              <label>외부 모델</label>
              <select defaultValue="openai/gpt-4o-mini">
                <option>openai/gpt-4o-mini</option>
                <option>meta-llama/llama-3.1-70b-instruct</option>
              </select>
            </div>
            <div className="field">
              <label>로컬 모델</label>
              <select defaultValue="ollama/llama3.1:8b">
                <option>ollama/llama3.1:8b</option>
                <option>ollama/qwen2.5:7b</option>
              </select>
            </div>
            <div className="field">
              <label>월 비용 한도 (원)</label>
              <input type="number" min={0} step={1000} defaultValue={costLimit} />
            </div>
            <div className="field">
              <span className="lbl">이번 달 사용</span>
              <div className="row">
                <Meter p={pct(costUsed, costLimit)} tone={pct(costUsed, costLimit) >= 90 ? "warn" : ""} />
                <span className="xs num">₩{num(costUsed)}</span>
              </div>
              <span className="hint">한도에 닿으면 로컬 모델로 폴백합니다.</span>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="zap" />
              도구 허용 목록 (allowlist)
            </h2>
          </div>
          <div className="list">
            {TOOLS.map(([k, label, risk]) => (
              <label className="li check" key={k}>
                <input type="checkbox" defaultChecked={ALLOW[k]} />
                <span className="li-t">
                  <b>{label}</b>
                  <small className="mono">{k}</small>
                </span>
                <Pill tone={RISK_TONE[risk]}>{RISK_LABEL[risk]}</Pill>
              </label>
            ))}
          </div>
          <div className="panel-b">
            <p className="hint">
              고위험 도구는 허용되어 있어도 결재 승인 + 재인증 없이 실행되지 않습니다. 목록 밖 도구 호출은 403입니다.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
