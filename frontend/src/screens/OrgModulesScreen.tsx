import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { isPgWorkspace } from "../services/workspace";
import { ScreenPage } from "../pages/ScreenPage";

const moduleSchema = z.object({
  key: z.string(),
  label: z.string(),
  core: z.boolean().catch(false),
  enabled: z.boolean().catch(false),
});
const listSchema = z.object({ items: z.array(moduleSchema) });
type Module = z.infer<typeof moduleSchema>;

// 조직 설정 > 모듈: 회사별 활성 모듈 토글. perp_db(org.company_modules) 저장.
export function OrgModulesScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  return isPgWorkspace(session?.orgId) ? <PgOrgModulesScreen screen={screen} /> : <ScreenPage screen={screen} />;
}

function PgOrgModulesScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const apiSession = useMemo(
    () => (session ? { token: session.token, orgId: session.orgId } : null),
    [session],
  );
  const [modules, setModules] = useState<readonly Module[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!apiSession) return;
    let alive = true;
    setStatus("loading");
    apiRequest("/pg/org/modules", { session: apiSession })
      .then((data) => {
        if (!alive) return;
        const items = listSchema.parse(data).items;
        setModules(items);
        setEnabled(new Set(items.filter((m) => m.enabled && !m.core).map((m) => m.key)));
        setStatus("ready");
      })
      .catch(() => alive && setStatus("error"));
    return () => {
      alive = false;
    };
  }, [apiSession]);

  function toggle(key: string): void {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (!apiSession) return;
    setSaving(true);
    setNotice(null);
    try {
      await apiRequest("/pg/org/modules", {
        method: "PATCH",
        body: { enabled: [...enabled] },
        session: apiSession,
      });
      setNotice("활성 모듈을 저장했습니다. 화면에 반영하려면 새로고침하세요.");
    } catch (error) {
      setNotice(userMessageOf(error));
    } finally {
      setSaving(false);
    }
  }

  const optional = modules.filter((m) => !m.core);
  const core = modules.filter((m) => m.core);

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">조직 설정</span>
            <Badge>{screen.id}</Badge>
          </div>
          <h1>모듈 설정</h1>
          <p>조직에서 사용할 모듈을 켜고 끕니다. 핵심 모듈은 항상 켜져 있습니다.</p>
        </div>
        <div className="screen-header__actions">
          <Button onClick={save} disabled={saving || status !== "ready"}>
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
          <p>모듈 정보를 불러오지 못했습니다. DB에 org.company_modules 가 적용됐는지 확인하세요.</p>
        </SectionCard>
      ) : (
        <>
          <SectionCard title="선택 모듈" subtitle="켜면 해당 화면과 기능이 열립니다">
            <ul className="form-stack" style={{ listStyle: "none", padding: 0 }}>
              {optional.map((m) => (
                <li key={m.key}>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={enabled.has(m.key)}
                      onChange={() => toggle(m.key)}
                      disabled={status !== "ready"}
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
