import { Link, Navigate } from "react-router-dom";

import { useSession } from "../store/session";

export function WelcomePage() {
  const session = useSession();
  if (!session) return <Navigate to="/login" replace />;
  if (session.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (session.orgId) return <Navigate to="/" replace />;
  return (
    <section className="auth-card auth-card--wide">
      <span className="eyebrow">WELCOME, {session.name.toUpperCase()}</span>
      <h2>어떤 방식으로 시작할까요?</h2>
      <p className="auth-card__intro">새 조직을 만들거나 받은 초대 링크로 기존 조직에 참여하세요.</p>
      <div className="choice-grid">
        <Link className="choice-card choice-card--primary" to="/onboarding/organization">
          <strong>새 조직 만들기</strong>
          <span>조직 유형과 필요한 모듈을 직접 선택합니다.</span>
          <em>설정 시작 →</em>
        </Link>
        <button
          type="button"
          className="choice-card"
          onClick={() => {
            const token = window.prompt("관리자에게 받은 초대 토큰을 붙여넣으세요.");
            if (token && token.trim()) {
              window.location.href = `/signup?invite=${encodeURIComponent(token.trim())}`;
            }
          }}
        >
          <strong>초대 링크로 참여</strong>
          <span>관리자가 보낸 초대 토큰으로 기존 조직에 참여합니다.</span>
          <em>초대 확인 →</em>
        </button>
      </div>
    </section>
  );
}
