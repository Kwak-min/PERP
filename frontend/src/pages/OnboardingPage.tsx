import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";

import { Button } from "../components/ui/Button";
import { apiRequest, userMessageOf } from "../services/api";
import { sessionStore, useSession } from "../store/session";

const catalogSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      core: z.boolean(),
      description: z.string(),
    }),
  ),
});

const orgSchema = z.object({
  org_id: z.string(),
  name: z.string(),
  type: z.string(),
});

const types = [
  ["club", "동아리·모임", "회비, 행사와 임원 운영 중심"],
  ["company", "소규모 기업", "프로젝트, 인사와 회계 중심"],
  ["lab", "연구실", "과제, 자산과 연구 기록 중심"],
  ["nonprofit", "비영리 단체", "후원, 사업과 증빙 중심"],
  ["student_council", "학생회", "부서, 행사와 예산 중심"],
  ["personal", "개인 프로젝트 관리 및 사용", "혼자 쓰는 프로젝트, 업무와 기록 중심"],
  ["custom", "직접 설정", "용어, 부서와 기능을 직접 선택"],
] as const;

export function OnboardingPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const TOTAL_STEPS = 4;
  const [type, setType] = useState("club");
  const [name, setName] = useState("");
  const [modules, setModules] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<z.infer<typeof catalogSchema>["items"]>([]);
  const [departments, setDepartments] = useState("");
  const [fiscalStart, setFiscalStart] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest("/tenants/modules/catalog")
      .then((data) => setCatalog(catalogSchema.parse(data).items))
      .catch((caught: unknown) => setError(userMessageOf(caught)));
  }, []);

  if (!session) return <Navigate to="/login" replace />;
  if (session.mustChangePassword) return <Navigate to="/change-password" replace />;

  function toggleModule(key: string): void {
    setModules((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }

  async function createOrganization(): Promise<void> {
    if (!session || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const organization = orgSchema.parse(
        await apiRequest("/tenants", {
          method: "POST",
          session: { token: session.token, orgId: null },
          body: {
            name: name.trim(),
            type,
            currency: "KRW",
            timezone: "Asia/Seoul",
            fiscal_year_start: fiscalStart,
            modules: catalog.filter((item) => item.core || modules.includes(item.key)).map((item) => item.key),
            departments:
              type === "custom"
                ? departments.split(",").map((item) => item.trim()).filter(Boolean)
                : undefined,
          },
        }),
      );
      sessionStore.patch({
        orgId: organization.org_id,
        organizations: [
          ...session.organizations,
          {
            org_id: organization.org_id,
            org_name: organization.name,
            org_type: organization.type,
            roles: ["owner"],
          },
        ],
      });
      navigate("/", { replace: true });
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <div className="stepper" aria-label={`조직 설정 ${step}/${TOTAL_STEPS}단계`}>
        {[1, 2, 3, 4].map((number) => (
          <span key={number} className={number <= step ? "active" : ""}>
            <b>{number}</b>
            {number === 1 ? "유형" : number === 2 ? "기본 정보" : number === 3 ? "기능" : "확인"}
          </span>
        ))}
      </div>
      <span className="eyebrow">ORGANIZATION SETUP</span>
      <h2 id="onboarding-title">
        {step === 1
          ? "조직 유형을 선택하세요"
          : step === 2
            ? "조직의 기본 정보를 알려주세요"
            : step === 3
              ? "필요한 기능을 선택하세요"
              : "입력한 내용을 확인하세요"}
      </h2>
      {error && <div className="form-error" role="alert">{error}</div>}

      {step === 1 && (
        <div className="type-grid" role="radiogroup" aria-label="조직 유형">
          {types.map(([key, label, description]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={type === key}
              className={type === key ? "selected" : ""}
              onClick={() => setType(key)}
            >
              <strong>{label}</strong><span>{description}</span>
            </button>
          ))}
        </div>
      )}
      {step === 2 && (
        <div className="form-stack">
          <label>조직 이름<input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 오비트 연구회" required /></label>
          <div className="form-split">
            <label>기본 통화<select defaultValue="KRW"><option value="KRW">KRW · 대한민국 원</option></select></label>
            <label>회계연도 시작<select value={String(fiscalStart)} onChange={(event) => setFiscalStart(Number(event.target.value))}><option value="1">1월</option><option value="3">3월</option><option value="7">7월</option></select></label>
          </div>
          {type === "custom" && (
            <label>추가할 부서 (선택, 쉼표로 구분)<input value={departments} onChange={(event) => setDepartments(event.target.value)} /></label>
          )}
        </div>
      )}
      {step === 3 && (
        <div className="module-list">
          {catalog.map((item) => (
            <label key={item.key} className={item.core ? "module-option module-option--core" : "module-option"}>
              <input
                type="checkbox"
                checked={item.core || modules.includes(item.key)}
                disabled={item.core}
                onChange={() => toggleModule(item.key)}
              />
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
              {item.core && <em>필수</em>}
            </label>
          ))}
        </div>
      )}

      {step === 4 && (
        <dl className="summary-review">
          <div><dt>유형</dt><dd>{types.find(([key]) => key === type)?.[1] ?? type}</dd></div>
          <div><dt>이름</dt><dd>{name.trim() || "—"}</dd></div>
          <div><dt>통화·회계연도</dt><dd>KRW · {fiscalStart}월 시작</dd></div>
          <div>
            <dt>켠 기능</dt>
            <dd>
              {catalog
                .filter((item) => item.core || modules.includes(item.key))
                .map((item) => item.label)
                .join(", ") || "기본 기능"}
            </dd>
          </div>
        </dl>
      )}

      <div className="onboarding-actions">
        <Button
          tone="neutral"
          onClick={() => (step > 1 ? setStep((value) => value - 1) : navigate("/welcome"))}
        >
          이전
        </Button>
        {step < TOTAL_STEPS ? (
          <Button disabled={step === 2 && !name.trim()} onClick={() => setStep((value) => value + 1)}>다음</Button>
        ) : (
          <Button disabled={busy || !name.trim()} onClick={createOrganization}>{busy ? "조직 생성 중…" : "조직 만들기"}</Button>
        )}
      </div>
    </section>
  );
}
