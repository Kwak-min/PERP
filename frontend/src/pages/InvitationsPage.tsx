import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '../components/ui/Button';
import { apiRequest, userMessageOf } from '../services/api';
import { isPgToken } from '../services/auth';
import { captureAuthTransition, clearInvitation, consumeReturnPath, parseInvitationCode, readAuthTransition } from '../services/authTransition';
import { sessionStore, useSession } from '../store/session';

const invitationSchema = z.object({ invitation_id: z.string(), email: z.string(), org_id: z.string(), org_name: z.string(),
  roles: z.array(z.string()), status: z.string(), expires_at: z.string() });
const verifySchema = z.object({ valid: z.boolean(), reason: z.string(), message: z.string(), invitation: invitationSchema.optional() });

export function InvitationsPage() {
  const session = useSession(), location = useLocation(), navigate = useNavigate();
  const [token, setToken] = useState(() => readAuthTransition().invite ?? '');
  const [checked, setChecked] = useState<z.infer<typeof verifySchema> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const parsedCode = parseInvitationCode(token);
  const storeMismatch = Boolean(session && parsedCode && isPgToken(session.token) !== isPgToken(parsedCode));
  useEffect(() => {
    captureAuthTransition(location.search);
    setToken(readAuthTransition().invite ?? '');
    if (!session?.mustChangePassword && location.search) navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate, session?.mustChangePassword]);
  useEffect(() => { setChecked(null); setError(null); }, [session?.token]);

  if (session?.mustChangePassword) return <Navigate to="/change-password" replace />;

  function remember(): string | null {
    const code = parseInvitationCode(token);
    if (!code) { setError('유효한 초대 코드 또는 링크를 입력하세요.'); return null; }
    captureAuthTransition(`?invite=${encodeURIComponent(code)}`);
    return code;
  }
  async function verify(): Promise<void> {
    const code = remember();
    if (!session || !code || storeMismatch) return;
    setBusy(true); setError(null); setChecked(null);
    try {
      const prefix = isPgToken(session.token) ? '/pg/auth' : '/auth';
      const result = verifySchema.parse(await apiRequest(`${prefix}/invitations/verify`, {
        method: 'POST', session: { token: session.token, orgId: null }, body: { token: code },
      }));
      setChecked(result);
    } catch (caught) { setError(userMessageOf(caught)); }
    finally { setBusy(false); }
  }
  async function accept(): Promise<void> {
    const code = remember();
    if (!session || !code || storeMismatch) return;
    setBusy(true); setError(null);
    try {
      const prefix = isPgToken(session.token) ? '/pg/auth' : '/auth';
      const joined = invitationSchema.parse(await apiRequest(`${prefix}/invitations/accept`, {
        method: 'POST', session: { token: session.token, orgId: null }, body: { token: code },
      }));
      if (sessionStore.getSnapshot()?.token !== session.token) return;
      clearInvitation();
      if (readAuthTransition().next === '/invitations') consumeReturnPath();
      sessionStore.patch({ orgId: null, preferredOrgId: joined.org_id, organizationStatus: 'loading' });
      navigate('/welcome', { replace: true });
    } catch (caught) { setError(userMessageOf(caught)); }
    finally { setBusy(false); }
  }
  const canJoin = checked?.valid || checked?.reason === 'accepted';
  return <section className="auth-card auth-card--wide" aria-labelledby="invitations-title">
    <span className="eyebrow">INVITATION</span>
    <h2 id="invitations-title">조직 초대 코드 입력</h2>
    <p className="auth-card__intro">관리자가 공유한 코드나 링크를 입력하세요. 초대받은 이메일의 계정만 참여할 수 있습니다.</p>
    {session && <p>로그인 계정: <b>{session.email}</b></p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="invite-manual">
      <label>초대 링크 또는 토큰
        <input value={token} maxLength={500} autoComplete="off" spellCheck={false} disabled={busy}
          onChange={event => { setToken(event.target.value); setChecked(null); setError(null); }} placeholder="받은 초대 코드 또는 링크" />
      </label>
      {storeMismatch && <p role="status" data-invitation-store-mismatch>
        이 초대는 현재 계정과 다른 저장소에서 발급되었습니다. 초대받은 이메일로 해당 저장소에 로그인하거나 계정을 만드세요. 같은 이메일이어도 계정과 기존 회사 소속은 합치지 않습니다.
      </p>}
      <div className="invite-manual__actions" style={{ flexWrap: 'wrap' }}>
        {session && !storeMismatch ? <>
          <Button tone="neutral" disabled={busy || !token.trim()} onClick={verify}>{busy ? '확인 중…' : '초대 확인'}</Button>
          {canJoin && <Button disabled={busy} onClick={accept}>{checked?.invitation?.org_name} 참여하기</Button>}
        </> : <>
          <Button disabled={!token.trim()} onClick={() => { if (remember()) navigate('/login'); }}>로그인하고 참여</Button>
          <Button tone="neutral" disabled={!token.trim()} onClick={() => { if (remember()) navigate('/signup'); }}>계정 만들고 참여</Button>
        </>}
      </div>
      {!storeMismatch && checked && <p className={checked.valid ? 'invite-check invite-check--ok' : 'invite-check invite-check--bad'} role="status">
        {checked.valid && checked.invitation ? `${checked.invitation.org_name} · ${checked.invitation.email} · 만료 ${new Date(checked.invitation.expires_at).toLocaleString()}` : checked.message}
      </p>}
      {checked?.reason === 'email_mismatch' && <Link to="/login">초대받은 계정으로 로그인</Link>}
    </div>
    <p className="auth-card__foot">초대가 없나요? <Link to={session ? '/onboarding/organization' : '/signup'}>새 조직 만들기</Link></p>
  </section>;
}
