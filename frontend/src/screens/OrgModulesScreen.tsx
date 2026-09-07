import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { isPgWorkspace } from "../services/workspace";
import { notifyAccessChanged, useAccess } from "../hooks/useWorkspaceAccess";

const moduleSchema = z.object({
  key: z.string(),
  label: z.string(),
  core: z.boolean().catch(false),
  enabled: z.boolean().catch(false),
});
const featureSchema = z.object({ key: z.string(), label: z.string(), description: z.string(), enabled: z.boolean() });
const listSchema = z.object({ items: z.array(moduleSchema), features: z.array(featureSchema) });
type Module = z.infer<typeof moduleSchema>;
type Feature = z.infer<typeof featureSchema>;

// 조직 설정 권한으로 모듈과 독립 기능만 변경한다. 역할 부여는 별도 설정이다.
export function OrgModulesScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const access = useAccess();
  const canSave = Boolean(access?.permissions.some(permission => permission === '*' || permission === 'organization.settings'));
  const nativePg = isPgWorkspace(session?.orgId);
  const catalogPath = nativePg ? "/pg/org/modules" : "/tenants/modules";
  const apiSession = useMemo(
    () => (session ? { token: session.token, orgId: session.orgId } : null),
    [session],
  );
  const [modules, setModules] = useState<readonly Module[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [features, setFeatures] = useState<readonly Feature[]>([]);
  const [enabledFeatures, setEnabledFeatures] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!apiSession) return;
    let alive = true;
    setStatus("loading");
    apiRequest(catalogPath, { session: apiSession })
      .then((data) => {
        if (!alive) return;
        const { items, features } = listSchema.parse(data);
        setModules(items);
        setFeatures(features);
        setEnabled(new Set(items.filter((m) => m.enabled && !m.core && m.key !== 'approvals').map((m) => m.key)));
        setEnabledFeatures(new Set(features.filter(feature => feature.enabled).map(feature => feature.key)));
        setStatus("ready");
      })
      .catch(() => alive && setStatus("error"));
    return () => {
      alive = false;
    };
  }, [apiSession, catalogPath]);

  function toggle(key: string): void {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (!apiSession || !canSave) return;
    setSaving(true);
    setNotice(null);
    try {
      const saved = z.object({ enabled_features: z.array(z.string()) }).parse(await apiRequest(nativePg ? "/pg/org/modules" : "/tenants/current", {
        method: "PATCH",
        body: { ...(nativePg ? { enabled: [...enabled] } : { modules: [...enabled] }), features: [...enabledFeatures] },
        session: apiSession,
      }));
      setEnabledFeatures(new Set(saved.enabled_features));
      notifyAccessChanged();
      setNotice("모듈과 기능 사용 설정을 저장했습니다. 메뉴 접근은 부여된 역할 권한에 따라 반영됩니다.");
    } catch (error) {
      setNotice(userMessageOf(error));
    } finally {
      setSaving(false);
    }
  }

  const optional = modules.filter((m) => !m.core && m.key !== 'approvals');
  const core = modules.filter((m) => m.core);

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">조직 설정</span>
            <Badge>{screen.id}</Badge>
          </div>
          <h1>모듈 및 기능 설정</h1>
          <p>조직의 사용 가능 여부를 설정합니다. 기능을 켜도 구성원의 역할 권한은 변경되지 않습니다.</p>
        </div>
        <div className="screen-header__actions">
          <Button onClick={save} disabled={!canSave || saving || status !== "ready"}>
            {saving ? "저장 중…" : "저장"}
          </Button>
        </div>
      </header>

      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      {status === "error" ? (
        <SectionCard title="모듈" subtitle="불러오기 실패">
          <p>모듈과 기능 정보를 불러오지 못했습니다. 조직 설정 권한과 서버 상태를 확인하세요.</p>
        </SectionCard>
      ) : (
        <>
          <SectionCard title="기능" subtitle="근태·휴가·전자결재는 각각 독립적으로 사용 여부를 설정합니다">
            <ul className="form-stack" style={{ listStyle: "none", padding: 0 }}>
              {features.map(feature => (
                <li key={feature.key}>
                  <label className="check-label">
                    <input type="checkbox" checked={enabledFeatures.has(feature.key)}
                      disabled={!canSave || saving || status !== "ready"}
                      onChange={() => setEnabledFeatures(previous => {
                        const next = new Set(previous);
                        if (next.has(feature.key)) next.delete(feature.key);
                        else next.add(feature.key);
                        return next;
                      })} />
                    {feature.label} <small>{feature.description}</small>
                  </label>
                </li>
              ))}
            </ul>
          </SectionCard>
          <SectionCard title="선택 모듈" subtitle="모듈 사용 여부와 역할 권한이 모두 있어야 접근할 수 있습니다">
            <ul className="form-stack" style={{ listStyle: "none", padding: 0 }}>
              {optional.map((m) => (
                <li key={m.key}>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={enabled.has(m.key)}
                      onChange={() => toggle(m.key)}
                      disabled={!canSave || saving || status !== "ready"}
                    />
                    {m.label} <small style={{ opacity: 0.6 }}>({m.key})</small>
                  </label>
                </li>
              ))}
            </ul>
          </SectionCard>
          <SectionCard title="핵심 모듈" subtitle="항상 켜짐 (변경 불가)">
            <div className="chip-row">
              {core.map((m) => (
                <Badge key={m.key} tone="neutral">{m.label}</Badge>
              ))}
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}
