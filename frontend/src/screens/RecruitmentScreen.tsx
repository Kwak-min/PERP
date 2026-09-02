import { useMemo, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { useMembers } from "../hooks/useMembers";
import type { ScreenDefinition } from "../routes/catalog";
import { useSession } from "../store/session";
import { OnboardingPanel } from "./recruitment/OnboardingPanel";
import { PipelinePanel } from "./recruitment/PipelinePanel";

import "./attendance.css";
import "./leave/leave.css";
import "./recruitment/recruitment.css";

export function RecruitmentScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const [tab, setTab] = useState<"pipeline" | "onboarding">("pipeline");

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );
  const members = useMembers(apiSession);

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">사람</span>
            <Badge>{screen.id}</Badge>
            <Badge>HR</Badge>
          </div>
          <h1>{screen.label}</h1>
          <p>{screen.description}</p>
        </div>
      </header>

      <div className="recruitment-tabs" role="tablist" aria-label="모집 화면 전환">
        <button type="button" role="tab" aria-pressed={tab === "pipeline"} onClick={() => setTab("pipeline")}>
          채용 파이프라인
        </button>
        <button type="button" role="tab" aria-pressed={tab === "onboarding"} onClick={() => setTab("onboarding")}>
          온보딩 체크리스트
        </button>
      </div>

      {apiSession && tab === "pipeline" && <PipelinePanel apiSession={apiSession} />}
      {apiSession && tab === "onboarding" && <OnboardingPanel apiSession={apiSession} members={members} />}
    </div>
  );
}
