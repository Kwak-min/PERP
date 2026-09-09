import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { Button } from "../components/ui/Button";
import { login } from "../services/auth";
import { captureAuthTransition } from "../services/authTransition";
import { userMessageOf } from "../services/api";
import { sessionStore } from "../store/session";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    captureAuthTransition(location.search);
    if (location.search) navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const session = await login(String(form.get("email")), String(form.get("password")));
      sessionStore.set(session, form.get("remember") !== null);
      navigate(
        session.mustChangePassword ? "/change-password" : "/welcome",
        { replace: true },
      );
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="login-title">
      <span className="eyebrow">WELCOME BACK</span>
      <h2 id="login-title">OrbitFlow에 로그인</h2>
      <p className="auth-card__intro">오늘의 업무 흐름을 이어서 확인하세요.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <form className="form-stack" onSubmit={submit} onChange={() => setError(null)}>
        <label>
          이메일
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          비밀번호
          <input name="password" type="password" autoComplete="current-password" required minLength={8} />
        </label>
        <div className="form-row">
          <label className="check-label"><input type="checkbox" name="remember" defaultChecked /> 로그인 유지</label>
          <button className="text-button" type="button" onClick={() => setError("비밀번호 재설정 링크를 관리자에게 요청하세요.")}>비밀번호 찾기</button>
        </div>
        <Button type="submit" disabled={busy}>{busy ? "확인 중…" : "로그인"}</Button>
      </form>
      <p className="auth-card__foot">처음이신가요? <Link to="/signup">계정 만들기</Link></p>
    </section>
  );
}
