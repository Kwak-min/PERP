import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";

import { Button } from "../components/ui/Button";
import { ApiError, apiRequest, userMessageOf } from "../services/api";
import { isPgToken, organizationsOf } from "../services/auth";
import { consumeReturnPath, readAuthTransition } from "../services/authTransition";
import { sessionStore, useSession } from "../store/session";
import "./onboarding.css";

const catalogItemSchema = z.object({ key: z.string(), label: z.string(), core: z.boolean(), description: z.string() });
const featureItemSchema = catalogItemSchema.omit({ core: true });
const catalogSchema = z.object({ items: z.array(catalogItemSchema), features: z.array(featureItemSchema) });
const templatesSchema = z.object({ items: z.array(z.object({ type: z.string(), modules: z.array(z.string()) })) });
const orgSchema = z.object({ org_id: z.string(), name: z.string(), type: z.string() });

const primaryTypes = [
  ["personal", "개인", "내 수입·지출, 할 일과 기록을 한곳에서"],
  ["company", "소규모 팀", "함께하는 업무, 일정과 팀 비용 관리"],
  ["club", "동아리·모임", "회비, 행사와 운영 인수인계"],
  ["lab", "연구실", "연구 과제, 연구비와 장비·자료 관리"],
] as const;
const otherTypes = [
  ["nonprofit", "비영리 단체", "후원, 사업과 증빙 중심"],
  ["student_council", "학생회", "행사와 예산 중심"],
  ["study", "스터디", "함께 공부하는 일정과 기록"],
  ["custom", "직접 설정", "필요한 기능을 직접 선택"],
] as const;
const types = [...primaryTypes, ...otherTypes];
const moduleCopy: Record<string, { label: string; description: string }> = {
  finance: { label: "돈 관리", description: "수입·지출, 회비와 예산을 기록합니다. 공간을 만든 뒤 돈 관리를 시작하세요." },
  agent: { label: "AI 비서·개인 노트", description: "개인 노트와 AI 도움을 함께 사용합니다." },
};
type Selection = { modules: string[]; features: string[] };

export function OnboardingPage() {
  const session = useSession();
  const navigate = useNavigate();
  const nativePg = isPgToken(session?.token ?? "");
  const [step, setStep] = useState(1);
  const TOTAL_STEPS = 4;
  const [type, setType] = useState<string>(nativePg ? "company" : "club");
  const [name, setName] = useState("");
  const organizationName = type === "personal" ? session?.name.trim() ?? "" : name.trim();
  const [drafts, setDrafts] = useState<Record<string, Selection>>({});
  const [recommendations, setRecommendations] = useState<Record<string, string[]>>({});
  const recommended = recommendations[type] ?? [];
  // 유형별 초안이 있으면 추천을 다시 적용하지 않는다. 빈 선택도 명시적인 선택이다.
  const { modules, features } = drafts[type] ?? { modules: recommended, features: [] };
  const [catalog, setCatalog] = useState<z.infer<typeof catalogItemSchema>[]>([]);
  const [featureCatalog, setFeatureCatalog] = useState<z.infer<typeof featureItemSchema>[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [fiscalStart, setFiscalStart] = useState(1);
  const [busy, setBusy] = useState(false);
  const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([
      apiRequest("/tenants/modules/catalog", { signal: controller.signal }),
      apiRequest("/tenants/templates", { signal: controller.signal }),
    ]).then(([data, templates]) => {
      if (controller.signal.aborted) return;
      const parsed = catalogSchema.parse(data);
      const profiles = templatesSchema.parse(templates);
      setCatalog(parsed.items.map(item => ({ ...item, ...moduleCopy[item.key] })));
      setFeatureCatalog(parsed.features);
      setRecommendations(Object.fromEntries(profiles.items.map(item => [item.type, item.modules.filter(key => key !== "approvals")])));
      setLoaded(true);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(userMessageOf(caught));
    });
    return () => controller.abort();
  }, [loadAttempt]);

  if (!session) return <Navigate to="/login" replace />;
  if (session.mustChangePassword) return <Navigate to="/change-password" replace />;

  function toggle(key: string, field: keyof Selection): void {
    setDrafts(current => {
      const selection = current[type] ?? { modules: recommended, features: [] };
      const values = selection[field];
      return { ...current, [type]: { ...selection, [field]: values.includes(key) ? values.filter(item => item !== key) : [...values, key] } };
    });
  }

  function renderType([key, label, description]: readonly [string, string, string]) {
    return <label key={key} className={`profile-option${type === key ? " selected" : ""}`}>
      <input type="radio" name="workspace-profile" data-profile={key} checked={type === key} onChange={() => setType(key)} />
      <span><strong>{label}</strong><span>{description}</span></span>
    </label>;
  }

  function renderModule(item: z.infer<typeof catalogItemSchema>) {
    return <label key={item.key} className="module-option" data-module={item.key}>
      <input type="checkbox" checked={modules.includes(item.key)} onChange={() => toggle(item.key, "modules")} />
      <span><strong>{item.label}</strong><small>{item.description}</small></span>
    </label>;
  }

  async function createOrganization(): Promise<void> {
    if (!session || !organizationName || !loaded) return;
    setBusy(true);
    setError(null);
    try {
      const organization = createdOrgId ? { org_id: createdOrgId } : orgSchema.parse(
        await apiRequest(nativePg ? "/pg/companies" : "/tenants", {
          method: "POST",
          session: { token: session.token, orgId: null },
          body: {
            name: organizationName,
            type,
            modules: catalog.filter(item => item.key !== "approvals" && (item.core || modules.includes(item.key))).map(item => item.key),
            features,
            ...(!nativePg ? { currency: "KRW", timezone: "Asia/Seoul", fiscal_year_start: fiscalStart } : {}),
          },
        }),
      );
      // 생성은 이미 완료됐다. 소속 조회만 실패하면 같은 공간을 다시 확인한다.
      setCreatedOrgId(organization.org_id);
      const organizations = await organizationsOf(session.token);
      const created = organizations.find(org => org.org_id === organization.org_id);
      if (!created) {
        throw new ApiError("생성된 공간의 소속을 확인할 수 없습니다. 다시 로그인해 주세요.", {
          code: "NO_ORGANIZATION", status: 403, requestId: "", details: {},
        });
      }
      sessionStore.patch({ orgId: created.org_id, organizations: [...organizations], organizationStatus: "ready" });
      navigate(readAuthTransition().invite ? "/invitations" : consumeReturnPath() ?? "/", { replace: true });
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <div className="stepper" aria-label={`공간 설정 ${step}/${TOTAL_STEPS}단계`}>
        {[1, 2, 3, 4].map(number => (
          <span key={number} className={number <= step ? "active" : ""} aria-current={number === step ? "step" : undefined}>
            <b>{number}</b>{number === 1 ? "유형" : number === 2 ? "기본 정보" : number === 3 ? "기능" : "확인"}
          </span>
        ))}
      </div>
      <span className="eyebrow">나에게 맞는 시작</span>
      <h2 id="onboarding-title">{step === 1 ? "어떤 공간이 필요한가요?" : step === 2 ? "공간의 이름을 알려주세요" : step === 3 ? "추천 기능을 확인하세요" : "입력한 내용을 확인하세요"}</h2>
      {error && <div className="form-error" role="alert">{error}{!loaded && <Button tone="neutral" onClick={() => setLoadAttempt(value => value + 1)}>다시 불러오기</Button>}</div>}
      {!loaded && !error && <p role="status">시작 유형과 추천 기능을 불러오는 중…</p>}

      {step === 1 && <>
        <p className="onboarding-note">유형에 맞는 기능을 미리 골라드립니다. 다음 단계에서 자유롭게 바꿀 수 있어요.</p>
        <div className="type-grid type-grid--primary" role="radiogroup" aria-label="공간 유형">{primaryTypes.map(renderType)}</div>
        {!nativePg && <details className="onboarding-options">
          <summary>다른 유형으로 시작</summary>
          <div className="type-grid" role="radiogroup" aria-label="다른 공간 유형">{otherTypes.map(renderType)}</div>
        </details>}
      </>}
      {step === 2 && <div className="form-stack">
        <label>조직 이름<input value={type === "personal" ? organizationName : name} readOnly={type === "personal"} onChange={event => setName(event.target.value)} placeholder="예: 오비트 연구회" required maxLength={200} /></label>
        {type === "personal" && <p className="onboarding-note">개인 공간은 가입한 이름을 사용합니다.</p>}
        {!nativePg && <details className="onboarding-options">
          <summary>통화·회계연도 설정</summary>
          <div className="form-split">
            <label>기본 통화<select defaultValue="KRW"><option value="KRW">KRW · 대한민국 원</option></select></label>
            <label>회계연도 시작<select value={String(fiscalStart)} onChange={event => setFiscalStart(Number(event.target.value))}><option value="1">1월</option><option value="3">3월</option><option value="7">7월</option></select></label>
          </div>
        </details>}
      </div>}
      {step === 3 && <>
        <p className="onboarding-note">{types.find(([key]) => key === type)?.[1]}에 추천하는 기능입니다. 필요 없는 기능은 꺼도 됩니다.</p>
        <div className="module-list" aria-label="추천 기능">{catalog.filter(item => !item.core && recommended.includes(item.key)).map(renderModule)}</div>
        <details className="onboarding-options">
          <summary>다른 기능 선택{features.length ? ` · 추가 기능 ${features.length}개 선택` : ""}</summary>
          <p className="onboarding-note">결재·근태·휴가는 필요한 경우에만 켜세요.</p>
          <div className="module-list">
            {featureCatalog.map(item => <label key={item.key} className="module-option" data-feature={item.key}>
              <input type="checkbox" checked={features.includes(item.key)} onChange={() => toggle(item.key, "features")} />
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </label>)}
            {catalog.filter(item => !item.core && item.key !== "approvals" && !recommended.includes(item.key)).map(renderModule)}
          </div>
        </details>
        <details className="onboarding-core">
          <summary>기본 기능은 항상 제공됩니다</summary>
          <p className="onboarding-note">공간 운영에 필요한 {catalog.filter(item => item.core).map(item => item.label).join(", ")}은 별도 선택 없이 사용할 수 있습니다.</p>
        </details>
      </>}
      {step === 4 && <>
        <dl className="summary-review">
          <div><dt>유형</dt><dd>{types.find(([key]) => key === type)?.[1] ?? type}</dd></div>
          <div><dt>이름</dt><dd>{organizationName || "—"}</dd></div>
          {!nativePg && <div><dt>통화·회계연도</dt><dd>KRW · {fiscalStart}월 시작</dd></div>}
          <div><dt>켠 기능</dt><dd>{[
            ...featureCatalog.filter(item => features.includes(item.key)).map(item => item.label),
            ...catalog.filter(item => !item.core && item.key !== "approvals" && modules.includes(item.key)).map(item => item.label),
          ].join(", ") || "기본 기능만 사용"}</dd></div>
        </dl>
        <p className="onboarding-note">공간만 만듭니다. 부서와 프로젝트는 필요할 때 직접 추가하세요.{modules.includes("finance") && " 수입·지출 기록은 공간을 만든 뒤 돈 관리에서 시작할 수 있습니다."}</p>
      </>}
      <div className="onboarding-actions">
        <Button tone="neutral" disabled={busy || createdOrgId !== null} onClick={() => step > 1 ? setStep(value => value - 1) : navigate("/welcome")}>이전</Button>
        {step < TOTAL_STEPS
          ? <Button disabled={!loaded || (step === 2 && !organizationName)} onClick={() => setStep(value => value + 1)}>다음</Button>
          : <Button disabled={busy || !organizationName || !loaded} onClick={createOrganization}>{busy ? "공간 확인 중…" : createdOrgId ? "소속 다시 확인" : "조직 만들기"}</Button>}
      </div>
    </section>
  );
}
