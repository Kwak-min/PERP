import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { OrbitArt } from "../components/ui/OrbitArt";
import { login } from "../services/auth";
import { userMessageOf } from "../services/api";
import { DEMO_ACCOUNTS, sessionForDemo, type DemoAccount } from "../store/demoAccounts";
import { sessionStore } from "../store/session";

function LogoMark() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" style={{ fill: "var(--of-primary)" }} />
      <ellipse cx="16" cy="16" rx="11" ry="5.2" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.6" transform="rotate(-28 16 16)" />
      <circle cx="16" cy="16" r="4.2" fill="#fff" />
      <circle cx="25.2" cy="11.2" r="2.2" fill="#C4B5FD" />
    </svg>
  );
}

// AUTH-001 로그인 — 목업 login 이식
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextPath = new URLSearchParams(location.search).get("next") || "/";

  function demoLogin(a: DemoAccount): void {
    setError(null);
    sessionStore.set(sessionForDemo(a));
    navigate(nextPath, { replace: true });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const session = await login(String(form.get("email")), String(form.get("password")));
      sessionStore.set(session);
      navigate(session.mustChangePassword ? "/change-password" : nextPath, { replace: true });
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-brand">
        <OrbitArt />
        <div className="brand-row">
          <LogoMark />
          <div>
            <b>PERP</b>
            <br />
            <small>소규모 조직 ERP 운영 OS</small>
          </div>
        </div>
        <div className="stack loose" style={{ position: "relative" }}>
          <h1>흩어진 조직 운영을 하나의 궤도로</h1>
          <p>
            동아리·학생회·연구실·소기업의 회원·회계·일정·문서·인수인계를 한곳에서 관리하고, 권한을 아는 AI Agent가
            브리핑·검색·초안·승인 기반 실행을 돕습니다.
          </p>
          <ul className="value-list">
            <li>
              <b>조직 인수인계 자동화</b>
              <span>담당자가 바뀌어도 문서·계정·반복업무가 남습니다</span>
            </li>
            <li>
              <b>회비·회계 정합성</b>
              <span>확정 전표만 원장에 · 마감 기간은 잠금</span>
            </li>
            <li>
              <b>권한 안전한 AI Agent</b>
              <span>권한 선필터 RAG · 고위험 실행은 승인+재인증</span>
            </li>
          </ul>
        </div>
        <div className="login-foot">
          국립순천대학교 우수작품 경진대회 출품작 · 기능 시연용 로컬 목업 (외부 연결 없음)
        </div>
      </section>

      <section className="login-main">
        <div className="login-card">
          <div className="stack tight">
            <span className="trace-id" style={{ justifySelf: "start" }}>
              AUTH-001 · SER-001
            </span>
            <h2>로그인</h2>
            <p className="muted">
              시연 계정을 누르면 바로 들어갈 수 있습니다. 비밀번호는 모두 <code>demo1234</code>.
            </p>
          </div>
          <form className="stack" onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="lg-email">이메일</label>
              <input id="lg-email" name="email" type="email" autoComplete="username" required />
            </div>
            <div className="field">
              <label htmlFor="lg-pw">비밀번호</label>
              <input id="lg-pw" name="password" type="password" autoComplete="current-password" required />
            </div>
            {error && (
              <div className="callout bad" role="alert">
                <Icon name="alert" />
                <div>{error}</div>
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "확인 중…" : "로그인"}
            </button>
            <div className="row">
              <button
                type="button"
                className="btn grow"
                onClick={() =>
                  setError("Google SSO는 목업에서 외부 연결 없이 비활성화되어 있습니다. (OAuth 슬롯)")
                }
              >
                Google로 계속
              </button>
              <button
                type="button"
                className="btn grow"
                onClick={() =>
                  setError("Microsoft SSO는 목업에서 외부 연결 없이 비활성화되어 있습니다. (OAuth 슬롯)")
                }
              >
                Microsoft로 계속
              </button>
            </div>
          </form>
          <div className="or">시연 계정 (역할별 권한이 다릅니다)</div>
          <div className="demo-acc">
            {DEMO_ACCOUNTS.map((a) => (
              <button type="button" key={a.id} onClick={() => demoLogin(a)}>
                <span className="av" title={a.name}>
                  {a.name.slice(-2)}
                </span>
                <span className="pop-t">
                  <b>
                    {a.name} · {a.roleName}
                  </b>
                  <small>
                    {a.orgName} · {a.title}
                    {a.note ? ` · ${a.note}` : ""}
                  </small>
                </span>
                <Icon name="right" />
              </button>
            ))}
          </div>
          <p className="hint">
            초대 링크로 가입하려면 <a href="#/signup?token=inv-7Q2M-K9">초대 수락 화면</a>을 여세요. 비밀번호 5회 실패 시
            30초간 잠깁니다.
          </p>
        </div>
      </section>
    </div>
  );
}
