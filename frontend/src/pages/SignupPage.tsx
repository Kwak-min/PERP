import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { Button } from "../components/ui/Button";
import { userMessageOf } from "../services/api";
import { signup } from "../services/auth";
import { captureAuthTransition, readAuthTransition } from "../services/authTransition";
import { sessionStore } from "../store/session";

export function SignupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [invitation, setInvitation] = useState(() => readAuthTransition().invite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && password !== confirm;

  useEffect(() => {
    captureAuthTransition(location.search);
    setInvitation(readAuthTransition().invite);
    if (location.search) navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      setError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    const name = String(form.get("name")).replace(/[\p{Cf}\p{Cc}]/gu, "").trim();
    if (!name) {
      setError("이름을 입력해 주세요.");
      return;
    }
    if (name.length > 120) {
      setError("이름은 120자 이하로 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await signup(
        String(form.get("email")),
        name,
        String(form.get("password")),
      );
      sessionStore.set(session);
      navigate("/welcome", { replace: true, state: { accountCreated: true } });
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="signup-title">
      <span className="eyebrow">{invitation ? "INVITATION" : "GET STARTED"}</span>
      <h2 id="signup-title">{invitation ? "초대 참여를 위한 계정 만들기" : "계정 만들기"}</h2>
      <p className="auth-card__intro">계정을 만든 뒤 새 조직을 만들거나 초대 링크로 참여할 수 있습니다.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <form className="form-stack" onSubmit={submit}>
        <label>이름<input name="name" required autoComplete="name" /></label>
        <label>이메일<input name="email" type="email" required autoComplete="email" /></label>
        <label>
          비밀번호
          <input
            name="password"
            type="password"
            minLength={8}
            required
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          비밀번호 확인
          <input
            name="confirm"
            type="password"
            minLength={8}
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={mismatch}
            aria-describedby={mismatch ? "signup-confirm-error" : undefined}
          />
          {mismatch && (
            <small className="field-error" id="signup-confirm-error">
              비밀번호가 일치하지 않습니다.
            </small>
          )}
          {!mismatch && confirm.length > 0 && (
            <small className="field-ok">비밀번호가 일치합니다.</small>
          )}
        </label>
        <label className="check-label"><input type="checkbox" required /> 이용약관과 개인정보 처리방침에 동의합니다.</label>
        <Button type="submit" disabled={busy || mismatch}>{busy ? "계정 생성 중…" : "계정 만들기"}</Button>
      </form>
      <p className="auth-card__foot">이미 계정이 있나요? <Link to="/login">로그인</Link></p>
    </section>
  );
}
