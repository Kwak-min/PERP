import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { Button } from "../components/ui/Button";
import { apiRequest, userMessageOf } from "../services/api";
import { sessionStore, useSession } from "../store/session";

export function ChangePasswordPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session) return <Navigate to="/login" replace />;

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!session) return;
    const form = new FormData(event.currentTarget);
    if (form.get("new") !== form.get("confirm")) {
      setError("새 비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/auth/password", {
        method: "POST",
        session: { token: session.token, orgId: null },
        body: {
          current_password: String(form.get("current")),
          new_password: String(form.get("new")),
        },
      });
      sessionStore.clear();
      navigate("/login", { replace: true });
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card">
      <span className="eyebrow">SECURITY REQUIRED</span>
      <h2>임시 비밀번호 변경</h2>
      <p className="auth-card__intro">조직 데이터에 접근하기 전에 본인만 아는 비밀번호로 변경하세요.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <form className="form-stack" onSubmit={submit}>
        <label>현재 임시 비밀번호<input name="current" type="password" required autoComplete="current-password" /></label>
        <label>새 비밀번호<input name="new" type="password" required minLength={8} autoComplete="new-password" /></label>
        <label>새 비밀번호 확인<input name="confirm" type="password" required minLength={8} autoComplete="new-password" /></label>
        <Button type="submit" disabled={busy}>{busy ? "변경 중…" : "비밀번호 변경"}</Button>
      </form>
    </section>
  );
}
