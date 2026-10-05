import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { PageHead } from "../screens/mockup/lib";
import { apiRequest, userMessageOf } from "../services/api";
import { refreshSession } from "../services/auth";
import { sessionStore, useSession } from "../store/session";

// 목업 조직 유형 → 백엔드 조직 유형 키
const TYPE_MAP: Record<string, string> = {
  student: "student_council",
  club: "club",
  lab: "lab",
  company: "company",
};

const ORG_TYPES: Array<[string, string]> = [
  ["student", "학생회"],
  ["club", "동아리"],
  ["lab", "연구실"],
  ["company", "기업"],
];
const ORG_TYPE_INFO: Record<string, { desc: string; terms: string; accounts: string }> = {
  student: { desc: "학생회비·행사·집행부 인수인계 중심", terms: "행사활동 · 예산·회계 · 학생회원", accounts: "학생회비, 학교 지원금, 행사운영비, 식비·다과, 인쇄·홍보, 비품·소모품" },
  club: { desc: "회비·활동 참여·장비 대여 중심", terms: "활동 참여 · 회비·활동비 · 동아리원", accounts: "월 회비, 지원금, 활동비, 장비 구입, 대관료" },
  lab: { desc: "연구비·장비·연구활동 기록 중심", terms: "연구활동 · 연구비 · 연구원", accounts: "연구비 입금, 연구재료비, 출장비, 회의비, 장비비" },
  company: { desc: "근태·결재·회계·자산 전반", terms: "근태 · 회계 · 임직원", accounts: "매출, 인건비, 운영비, 사무용품" },
};
const MODULES: Array<[string, string]> = [
  ["finance", "재무·회계"],
  ["asset", "자산·예약"],
  ["hr", "인사·근태"],
  ["handover", "인수인계"],
  ["automation", "자동화"],
  ["agent", "AI Agent"],
];
const ONB_STEPS = ["조직 유형", "이름·규모", "통화·회계연도", "사용 모듈", "시작 템플릿", "확인"];

// ONB-001 새 조직 만들기 — 목업 onboarding 이식
export function OnboardingPage() {
  const navigate = useNavigate();
  const session = useSession();
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(0);
  const [type, setType] = useState("club");
  const [name, setName] = useState("");
  const [size, setSize] = useState("11~30명");
  const [currency, setCurrency] = useState("KRW");
  const [fiscalStart, setFiscalStart] = useState("3");
  const [modules, setModules] = useState(MODULES.map(([k]) => k));
  const [template, setTemplate] = useState("sample");
  const [err, setErr] = useState<string | null>(null);

  const toggleModule = (k: string) =>
    setModules((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));

  function go(delta: number): void {
    if (delta > 0 && step === 1 && !name.trim()) {
      setErr("조직 이름을 입력하세요.");
      return;
    }
    setErr(null);
    setStep((s) => Math.max(0, Math.min(5, s + delta)));
  }

  async function create(): Promise<void> {
    if (!name.trim()) {
      setStep(1);
      setErr("조직 이름을 입력하세요.");
      return;
    }
    if (!session) {
      navigate("/login", { replace: true });
      return;
    }
    setCreating(true);
    setErr(null);
    try {
      const res = (await apiRequest("/tenants", {
        method: "POST",
        session: { token: session.token, orgId: null },
        body: {
          name: name.trim(),
          type: TYPE_MAP[type] ?? "club",
          currency,
          fiscal_year_start: Number(fiscalStart) || 1,
        },
      })) as { org_id: string };
      const refreshed = await refreshSession(session.token, res.org_id);
      sessionStore.set(refreshed);
      navigate("/", { replace: true });
    } catch (caught) {
      setErr(userMessageOf(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px" }}>
      <PageHead
        title="새 조직 만들기"
        id="ONB-001"
        fr="SFR-001 · SFR-002"
        desc="조직 유형에 따라 용어·기본 메뉴·계정과목·샘플 데이터가 달라집니다."
      />
      <ol className="stepper">
        {ONB_STEPS.map((s, i) => (
          <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
            <b>{i < step ? "✓" : i + 1}</b>
            {s}
          </li>
        ))}
      </ol>
      <div className="panel">
        <div className="panel-h">
          <h2>{ONB_STEPS[step]}</h2>
          <span className="muted xs">{step + 1} / 6</span>
        </div>
        <div className="panel-b stack">
          {step === 0 && (
            <div className="type-cards">
              {ORG_TYPES.map(([k, l]) => (
                <button
                  type="button"
                  key={k}
                  className={`type-card${type === k ? " on" : ""}`}
                  aria-pressed={type === k}
                  onClick={() => setType(k)}
                >
                  <b>{l}</b>
                  <small>{ORG_TYPE_INFO[k]!.desc}</small>
                  <small className="mono">용어: {ORG_TYPE_INFO[k]!.terms}</small>
                </button>
              ))}
            </div>
          )}
          {step === 1 && (
            <div className="form-grid">
              <div className="field span2">
                <label>조직 이름</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 순천대 로봇 동아리 R2"
                />
              </div>
              <div className="field">
                <label>규모</label>
                <select value={size} onChange={(e) => setSize(e.target.value)}>
                  {["1~10명", "11~30명", "31~100명", "100명 이상"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="form-grid">
              <div className="field">
                <label>기본 통화</label>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  <option value="KRW">KRW (원)</option>
                  <option value="USD">USD ($)</option>
                </select>
                <span className="hint">금액은 정수 최소화폐단위로 저장합니다.</span>
              </div>
              <div className="field">
                <label>회계연도 시작 월</label>
                <select value={fiscalStart} onChange={(e) => setFiscalStart(e.target.value)}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1}월
                    </option>
                  ))}
                </select>
                <span className="hint">학생회·동아리는 보통 3월, 기업은 1월.</span>
              </div>
            </div>
          )}
          {step === 3 && (
            <div className="stack">
              {MODULES.map(([k, l]) => (
                <label className="check" key={k}>
                  <input type="checkbox" checked={modules.includes(k)} onChange={() => toggleModule(k)} />{" "}
                  <span>
                    <b>{l}</b> <span className="muted xs">— 끄면 메뉴가 숨고 API는 403 MODULE_DISABLED</span>
                  </span>
                </label>
              ))}
              <p className="hint">프로젝트·업무·캘린더·문서·결재는 공통 기능이라 항상 켜집니다.</p>
            </div>
          )}
          {step === 4 && (
            <div className="type-cards">
              {[
                ["sample", "샘플 데이터 포함", "첫 프로젝트·업무 3건·소개 문서·유형별 계정과목을 만들어 바로 둘러볼 수 있습니다."],
                ["blank", "빈 조직", "계정과목과 기본 결재선만 만들고 나머지는 비워 둡니다."],
              ].map(([k, l, d]) => (
                <button
                  type="button"
                  key={k}
                  className={`type-card${template === k ? " on" : ""}`}
                  onClick={() => setTemplate(k!)}
                >
                  <b>{l}</b>
                  <small>{d}</small>
                </button>
              ))}
            </div>
          )}
          {step === 5 && (
            <>
              <dl className="kv">
                <dt>유형</dt>
                <dd>{ORG_TYPES.find(([k]) => k === type)?.[1]}</dd>
                <dt>이름</dt>
                <dd>{name || "(미입력)"}</dd>
                <dt>규모</dt>
                <dd>{size}</dd>
                <dt>통화·회계연도</dt>
                <dd>
                  {currency} · {fiscalStart}월 시작
                </dd>
                <dt>모듈</dt>
                <dd>{modules.map((k) => MODULES.find(([m]) => m === k)?.[1]).join(", ") || "없음"}</dd>
                <dt>계정과목</dt>
                <dd>{ORG_TYPE_INFO[type]!.accounts}</dd>
                <dt>시작 템플릿</dt>
                <dd>{template === "sample" ? "샘플 데이터 포함" : "빈 조직"}</dd>
              </dl>
              <div className="callout info">
                <Icon name="shield" />
                <div>
                  만든 사람은 <b>조직 소유자</b>가 되며, 새 조직의 데이터는 기존 조직과 완전히 격리됩니다.
                </div>
              </div>
            </>
          )}
          {err && (
            <div className="callout bad" role="alert">
              <Icon name="alert" />
              <div>{err}</div>
            </div>
          )}
        </div>
        <div className="dlg-f">
          <button type="button" className="btn" onClick={() => go(-1)} disabled={step === 0}>
            이전
          </button>
          {step < 5 ? (
            <button type="button" className="btn btn-primary" onClick={() => go(1)}>
              다음
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={create} disabled={creating}>
              {creating ? "만드는 중…" : "조직 만들기"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
