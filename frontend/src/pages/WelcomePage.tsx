import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { loadSessionOrganizations, organizationsOf } from "../services/auth";
import { consumeReturnPath, readAuthTransition } from "../services/authTransition";
import { userMessageOf } from "../services/api";
import { Button } from "../components/ui/Button";
import { sessionStore, useSession, type Organization } from "../store/session";

export function WelcomePage() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [organizations, setOrganizations] = useState<readonly Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const token = session?.token ?? null;

  // 로그인 이후에 만들어졌거나 초대를 수락한 조직도 여기서 다시 확인한다.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setOrganizations(null);
    setError(null);
    const load = sessionStore.getSnapshot()?.organizationStatus === "loading"
      ? loadSessionOrganizations : organizationsOf;
    void load(token).then((found) => {
      if (cancelled || sessionStore.getSnapshot()?.token !== token) return;
      setOrganizations(found);
      sessionStore.patch({ organizations: [...found] });
      if (readAuthTransition().invite) navigate("/invitations", { replace: true });
      else if (sessionStore.getSnapshot()?.orgId) navigate(consumeReturnPath() ?? "/", { replace: true });
    }).catch((caught: unknown) => {
      if (!cancelled) setError(userMessageOf(caught));
    });
    return () => {
      cancelled = true;
    };
  }, [token, attempt, navigate]);

  if (!session) return <Navigate to="/login" replace />;
  if (session.mustChangePassword) return <Navigate to="/change-password" replace />;

  if (error || organizations === null) {
    return (
      <section className="auth-card auth-card--wide">
        <h2>소속 조직 확인</h2>
        {location.state?.accountCreated === true && <p>계정이 생성되었습니다. 다시 가입하지 않아도 됩니다.</p>}
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button onClick={() => setAttempt((value) => value + 1)}>다시 확인</Button>
          </>
        ) : <p role="status">소속 조직을 확인하고 있습니다.</p>}
      </section>
    );
  }

  function enter(orgId: string): void {
    sessionStore.patch({ orgId });
    navigate(consumeReturnPath() ?? "/", { replace: true });
  }

  const hasOrganizations = organizations.length > 0;

  return (
    <section className="auth-card auth-card--wide">
      <span className="eyebrow">WELCOME, {session.name.toUpperCase()}</span>
      <h2>{hasOrganizations ? "어디로 들어갈까요?" : "어떤 방식으로 시작할까요?"}</h2>
      <p className="auth-card__intro">
        {hasOrganizations
          ? "이미 속한 조직으로 바로 들어가거나, 새 조직을 만들고 초대를 받을 수 있습니다."
          : "새 조직을 만들거나 받은 초대 링크로 기존 조직에 참여하세요."}
      </p>

      {hasOrganizations && (
        <div className="choice-grid">
          {organizations.map((org) => (
            <button
              key={org.org_id}
              type="button"
              className="choice-card choice-card--primary choice-card--button"
              onClick={() => enter(org.org_id)}
            >
              <strong>{org.org_name}</strong>
              <span>{org.roles.length > 0 ? org.roles.join(", ") : "이미 속해 있는 조직"}</span>
              <em>이 조직으로 들어가기 →</em>
            </button>
          ))}
        </div>
      )}

      <div className="choice-grid">
        <Link
          className={hasOrganizations ? "choice-card" : "choice-card choice-card--primary"}
          to="/onboarding/organization"
        >
          <strong>새 조직 만들기</strong>
          <span>조직 유형과 필요한 모듈을 직접 선택합니다.</span>
          <em>설정 시작 →</em>
        </Link>
        <Link className="choice-card" to="/invitations">
          <strong>초대 링크로 참여</strong>
          <span>{session.email} 주소로 온 초대를 확인하거나 초대 링크를 직접 입력합니다.</span>
          <em>초대 확인 →</em>
        </Link>
      </div>
    </section>
  );
}
