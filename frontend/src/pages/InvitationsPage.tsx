import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { Button } from "../components/ui/Button";
import { apiRequest, userMessageOf } from "../services/api";
import { captureAuthTransition, clearInvitation, consumeReturnPath, readAuthTransition } from "../services/authTransition";
import { sessionStore, useSession } from "../store/session";

const invitationSchema = z.object({
  invitation_id: z.string(),
  email: z.string(),
  org_id: z.string(),
  org_name: z.string(),
  org_type: z.string().nullable().catch(null),
  roles: z.array(z.string()).catch([]),
  status: z.string(),
  expires_at: z.string(),
});

const listSchema = z.object({ email: z.string(), items: z.array(invitationSchema) });

const verifySchema = z.object({
  valid: z.boolean(),
  reason: z.string(),
  message: z.string(),
  invitation: invitationSchema.optional(),
});

type Invitation = z.infer<typeof invitationSchema>;

function expiresLabel(value: string): string {
  const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
  return days <= 0 ? "만료됨" : `${days}일 남음`;
}

export function InvitationsPage() {
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [mailbox, setMailbox] = useState<readonly Invitation[] | null>(null);
  const [token, setToken] = useState(
    () => readAuthTransition().invite ?? "",
  );
  const [checked, setChecked] = useState<z.infer<typeof verifySchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiSession = session ? { token: session.token, orgId: null } : null;
  const canInspectInvitation = session !== null && !session.mustChangePassword;

  useEffect(() => {
    captureAuthTransition(location.search);
    setToken(readAuthTransition().invite ?? "");
    // 인증/비밀번호 가드가 이동할 때 쿼리 정리로 그 이동을 덮어쓰지 않는다.
    if (canInspectInvitation && location.search) navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate, canInspectInvitation]);

  useEffect(() => {
    if (!apiSession) return;
    apiRequest("/auth/invitations", { session: apiSession })
      .then((data) => setMailbox(listSchema.parse(data).items))
      .catch((caught: unknown) => {
        setMailbox([]);
        setError(userMessageOf(caught));
      });
    // 세션 토큰이 바뀔 때만 다시 조회한다.
  }, [session?.token]);

  if (!session) return <Navigate to="/login" replace />;
  if (session.mustChangePassword) return <Navigate to="/change-password" replace />;

  async function verify(): Promise<void> {
    if (!apiSession || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = verifySchema.parse(
        await apiRequest("/auth/invitations/verify", {
          method: "POST",
          session: apiSession,
          body: { token: token.trim() },
        }),
      );
      setChecked(result);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function accept(body: Readonly<{ token?: string; invitation_id?: string }>): Promise<void> {
    if (!apiSession || !session) return;
    setBusy(true);
    setError(null);
    try {
      const joined = invitationSchema.parse(
        await apiRequest("/auth/invitations/accept", {
          method: "POST",
          session: apiSession,
          body,
        }),
      );
      // 수락은 완료됐다. 소속 조회 장애 때문에 다시 수락하지 않도록 분리한다.
      clearInvitation();
      if (readAuthTransition().next === "/invitations") consumeReturnPath();
      sessionStore.patch({ orgId: null, preferredOrgId: joined.org_id, organizationStatus: "loading" });
      navigate("/welcome", { replace: true });
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card auth-card--wide" aria-labelledby="invitations-title">
      <span className="eyebrow">INVITATION</span>
      <h2 id="invitations-title">초대 확인</h2>
      <p className="auth-card__intro">
        <b>{session.email}</b> 주소로 도착한 초대를 확인합니다. 목록에 없으면 받은 초대 링크를 붙여넣어 확인하세요.
      </p>
      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="invite-mailbox" aria-live="polite">
        <h3>이 이메일로 온 초대</h3>
        {mailbox === null ? (
          <p className="invite-empty">초대를 확인하는 중입니다…</p>
        ) : mailbox.length === 0 ? (
          <p className="invite-empty">도착한 초대가 없습니다. 아래에 초대 링크를 직접 붙여넣어 확인하세요.</p>
        ) : (
          <ul className="invite-list">
            {mailbox.map((invite) => (
              <li key={invite.invitation_id}>
                <div>
                  <b>{invite.org_name}</b>
                  <span>
                    {invite.roles.join(", ") || "구성원"} · {expiresLabel(invite.expires_at)}
                  </span>
                </div>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => accept({ invitation_id: invite.invitation_id })}
                  aria-label={`${invite.org_name} 초대 수락`}
                >
                  참여하기
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="invite-manual">
        <h3>초대 링크로 확인</h3>
        <label>
          초대 링크 또는 토큰
          <input
            value={token}
            disabled={busy}
            onChange={(event) => {
              setToken(event.target.value);
              setChecked(null);
            }}
            placeholder="예: http://localhost:5173/signup?invite=abc123 또는 abc123"
          />
        </label>
        <div className="invite-manual__actions">
          <Button tone="neutral" disabled={busy || !token.trim()} onClick={verify}>
            {busy ? "확인 중…" : "초대 확인"}
          </Button>
          {checked?.valid && (
            <Button disabled={busy} onClick={() => accept({ token: token.trim() })}>
              {checked.invitation?.org_name} 참여하기
            </Button>
          )}
        </div>
        {checked && (
          <p className={checked.valid ? "invite-check invite-check--ok" : "invite-check invite-check--bad"} role="status">
            {checked.valid && checked.invitation
              ? `${checked.invitation.org_name} 초대입니다 · ${checked.invitation.roles.join(", ") || "구성원"} · ${expiresLabel(checked.invitation.expires_at)}`
              : checked.message}
          </p>
        )}
      </div>

      <p className="auth-card__foot">
        초대가 없나요? <Link to="/onboarding/organization">새 조직 만들기</Link>
      </p>
    </section>
  );
}
