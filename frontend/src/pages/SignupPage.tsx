import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { OrbitArt } from "../components/ui/OrbitArt";
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

// 데모 초대 (백엔드 없이 목업 초대 수락 시연)
const DEMO_INVITE = {
  token: "inv-7Q2M-K9",
  email: "newbie@example.com",
  role: "일반 구성원",
  orgName: "남부대 학생회",
  expiresAt: "2026-09-20",
};

// AUTH-002 초대 수락 — 목업 signup 이식
export function SignupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") || "";
  const inv = token === DEMO_INVITE.token ? DEMO_INVITE : null;
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const problem = !token
    ? "초대 링크가 올바르지 않습니다. 초대한 관리자에게 새 링크를 요청하세요."
    : !inv
      ? "초대 링크가 올바르지 않거나 만료되었습니다. 관리자에게 재발송을 요청하세요."
      : null;

  function submit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr("이름을 입력하세요.");
    if (password.length < 8) return setErr("비밀번호는 8자 이상이어야 합니다.");
    if (!agree) return setErr("필수 약관에 동의해야 가입할 수 있습니다.");
    sessionStore.set({
      token: "demo-new",
      orgId: "org-new",
      name: name.trim(),
      email: DEMO_INVITE.email,
      mustChangePassword: false,
      organizations: [
        { org_id: "org-new", org_name: DEMO_INVITE.orgName, org_type: "student", roles: [DEMO_INVITE.role] },
      ],
    });
    navigate("/", { replace: true });
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
            <small>초대 수락</small>
          </div>
        </div>
        <div />
        <div className="login-foot">AUTH-002 · SFR-003 회원·초대·상태 관리</div>
      </section>
      <section className="login-main">
        <div className="login-card">
          <h2>{inv ? `${inv.orgName}에 참여하기` : "초대 수락"}</h2>
          {problem ? (
            <>
              <div className="callout bad" role="alert">
                <Icon name="alert" />
                <div>{problem}</div>
              </div>
              <Link className="btn" to="/login">
                로그인으로
              </Link>
            </>
          ) : (
            <>
              <dl className="kv">
                <dt>초대 이메일</dt>
                <dd>{inv!.email}</dd>
                <dt>역할</dt>
                <dd>{inv!.role}</dd>
                <dt>만료</dt>
                <dd>{inv!.expiresAt}</dd>
              </dl>
              <form className="stack" onSubmit={submit} noValidate>
                <div className="field">
                  <label htmlFor="su-name">이름</label>
                  <input
                    id="su-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                  />
                </div>
                <div className="field">
                  <label htmlFor="su-pw">비밀번호 (8자 이상)</label>
                  <input
                    id="su-pw"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <label className="check">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />{" "}
                  <span>
                    이용약관 및 개인정보 수집·이용(이름·이메일)에 동의합니다. 주민등록번호는 수집하지 않습니다.
                  </span>
                </label>
                {err && (
                  <div className="callout bad" role="alert">
                    <Icon name="alert" />
                    <div>{err}</div>
                  </div>
                )}
                <button className="btn btn-primary" type="submit">
                  가입하고 참여하기
                </button>
              </form>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
