import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { z } from 'zod';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { useAccess } from '../../hooks/useWorkspaceAccess';
import { Button } from '../../components/ui/Button';
import './invitation-sharing.css';

const rolesSchema = z.object({ items: z.array(z.object({ key: z.string(), label: z.string(), scope: z.string() })) });
const createdSchema = z.object({ id: z.string().optional(), invitation_id: z.string().optional(), email: z.string(), token: z.string(), expires_at: z.string() });
const listSchema = z.object({ items: z.array(z.object({ invitation_id: z.string(), email: z.string(), status: z.string(), expires_at: z.string() })) });

type SharingProps = Readonly<{ session: ApiSession; open: boolean; onToggle: () => void }>;

export function InvitationSharingPanel({ session, open, onToggle }: SharingProps) {
  const access = useAccess();
  const allowed = access && (access.permissions.includes('*') || ['member.write', 'role.assign'].every(code => access.permissions.includes(code)));
  return allowed ? <SharingForm key={`${session.token}:${session.orgId}`} session={session} open={open} onToggle={onToggle} /> : <Link to="/invitations">받은 초대 코드 입력</Link>;
}
function SharingForm({ session, open, onToggle }: SharingProps) {
  const location = useLocation();
  const recipient = new URLSearchParams(location.search).get('inviteEmail') ?? '';
  const [email, setEmail] = useState(recipient), [selected, setSelected] = useState<string[]>([]);
  const [roles, setRoles] = useState<z.infer<typeof rolesSchema>['items']>([]);
  const [items, setItems] = useState<z.infer<typeof listSchema>['items']>([]);
  const [created, setCreated] = useState<z.infer<typeof createdSchema> | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(''); setRoles([]);
    Promise.all([apiRequest('/pg/members/invites/options', { session, signal: controller.signal }), apiRequest('/pg/members/invites', { session, signal: controller.signal })])
      .then(([options, list]) => {
        if (controller.signal.aborted) return;
        setRoles(rolesSchema.parse(options).items); setItems(listSchema.parse(list).items);
      }).catch(caught => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [open, revision, session.token, session.orgId]);
  const link = created ? `${window.location.origin}/invitations?invite=${encodeURIComponent(created.token)}` : '';
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setCreated(null);
    try {
      setCreated(createdSchema.parse(await apiRequest('/pg/members/invites', { method: 'POST', session, body: { email, roles: selected, expires_in_days: 7 } })));
      setRevision(value => value + 1);
    } catch (caught) { setError(userMessageOf(caught)); }
    finally { setBusy(false); }
  }
  async function copy(value: string) {
    setError(''); setNotice('');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        // HTTP에서는 Clipboard API가 없다. 클릭의 사용자 동작 안에서 동기 복사를 실행한다.
        const focused = document.activeElement;
        const selection = document.createElement('textarea');
        selection.value = value;
        selection.readOnly = true;
        selection.style.cssText = 'position:fixed;top:0;left:-9999px';
        selection.setAttribute('aria-hidden', 'true');
        document.body.append(selection);
        try {
          selection.focus({ preventScroll: true });
          selection.select();
          if (!document.execCommand('copy')) throw new Error('클립보드 복사가 거부되었습니다.');
        } finally {
          selection.remove();
          if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
        }
      }
      setNotice('복사했습니다. 초대받은 사람에게 직접 전달하세요.');
    } catch { setError('클립보드에 접근할 수 없습니다. 아래 코드나 링크를 선택해 복사하세요.'); }
  }
  async function share() {
    setError(''); setNotice('');
    try { await navigator.share({ title: 'OrbitFlow 조직 초대', url: link }); setNotice('공유 창을 닫았습니다. 수신자는 초대받은 이메일로 로그인해야 합니다.'); }
    catch (caught) { if (caught instanceof DOMException && caught.name === 'AbortError') setNotice('공유를 취소했습니다.'); else setError(userMessageOf(caught)); }
  }
  async function revoke(id: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await apiRequest(`/pg/members/invites/${encodeURIComponent(id)}/revoke`, { method: 'POST', session });
      if ((created?.invitation_id ?? created?.id) === id) setCreated(null);
      setRevision(value => value + 1); setNotice('초대를 취소했습니다.');
    } catch (caught) { setError(userMessageOf(caught)); }
    finally { setBusy(false); }
  }
  return <section id="member-invitation-sharing" className="invitation-sharing" aria-label="조직 초대 공유">
    <div className="invitation-sharing__actions">
      <Button tone="neutral" size="small" aria-expanded={open} onClick={onToggle}>구성원 초대 · 코드 공유</Button>
      <Link to="/invitations">받은 초대 코드 입력</Link>
    </div>
    {open && <>
      <p>관리자가 수신 이메일과 역할을 승인하여 초대를 만듭니다. 수신자가 수락하면 참여하며, 다른 회사의 기존 소속은 유지됩니다. 개인 API 키·즐겨찾기·개인 노트는 공유하지 않습니다.</p>
      <form onSubmit={create} className="invitation-sharing__form">
        <label>초대받을 이메일<input type="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
        <fieldset disabled={busy}><legend>허용할 역할</legend>
          {roles.map(role => <label className="invitation-sharing__role" key={role.key}><input type="checkbox" value={role.key} checked={selected.includes(role.key)}
            onChange={event => setSelected(keys => event.target.checked ? [...keys, role.key] : keys.filter(key => key !== role.key))} />{role.label}</label>)}
          {roles.length === 0 && <p>위임 가능한 역할을 확인하세요. 필요한 역할은 역할 설정에서 관리합니다.</p>}
        </fieldset>
        <Button type="submit" disabled={busy || selected.length === 0}>{busy ? '처리 중…' : '7일 초대 코드 만들기'}</Button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {created && <div className="invitation-sharing__result">
        <p><b>{created.email}</b> 전용 · 만료 {new Date(created.expires_at).toLocaleString()}</p>
        <p>이메일은 자동 발송되지 않습니다. 코드나 링크를 직접 공유하세요.</p>
        <label>초대 코드<input readOnly value={created.token} onFocus={event => event.target.select()} /></label>
        <label>초대 링크<input readOnly value={link} onFocus={event => event.target.select()} /></label>
        <div className="invitation-sharing__actions">
          <Button size="small" onClick={() => copy(created.token)}>코드 복사</Button>
          <Button size="small" tone="neutral" onClick={() => copy(link)}>링크 복사</Button>
          {typeof navigator.share === 'function' && <Button size="small" tone="neutral" onClick={share}>공유하기</Button>}
        </div>
      </div>}
      <ul className="invitation-sharing__list">{items.filter(item => item.status === 'pending').map(item => <li key={item.invitation_id}>
        <span>{item.email} · {new Date(item.expires_at).getTime() <= Date.now() ? '만료됨' : '수락 대기'}</span>
        <Button size="small" tone="neutral" disabled={busy} onClick={() => revoke(item.invitation_id)}>초대 취소</Button>
      </li>)}</ul>
    </>}
  </section>;
}
