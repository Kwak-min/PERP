import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import type { ScreenDefinition } from '../routes/catalog';
import { apiRequest, userMessageOf } from '../services/api';
import { useSession } from '../store/session';
import { notifyAccessChanged } from '../hooks/useWorkspaceAccess';
import { Button } from '../components/ui/Button';
import './role-settings.css';

const roleSchema = z.object({ key: z.string(), name: z.string(), label: z.string(), scope: z.string(), permissions: z.array(z.string()), system: z.boolean() });
const rolesSchema = z.object({ items: z.array(roleSchema), catalog: z.array(z.object({ code: z.string(), label: z.string(), kind: z.enum(['action', 'menu']) })), grantable: z.array(z.string()), scope: z.string() });
const membersSchema = z.object({ items: z.array(z.object({ membership_id: z.string(), user_id: z.string(), name: z.string(), email: z.string(), roles: z.array(z.string()) })) });
type Role = z.infer<typeof roleSchema>;
type Roles = z.infer<typeof rolesSchema>;
type Member = z.infer<typeof membersSchema>['items'][number];

export function RoleSettingsScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo(() => stored ? { token: stored.token, orgId: stored.orgId } : null, [stored?.token, stored?.orgId]);
  const pg = Boolean(session?.orgId?.startsWith('pg:'));
  const [data, setData] = useState<Roles | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState(pg ? 'all' : 'self');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [memberId, setMemberId] = useState('');
  const [assigned, setAssigned] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!session) return;
    const options = { session, ...(signal ? { signal } : {}) };
    const [roles, people] = await Promise.all([apiRequest('/settings/roles', options), apiRequest('/settings/members', options)]);
    if (!signal?.aborted) { setData(rolesSchema.parse(roles)); setMembers(membersSchema.parse(people).items); }
  }, [session]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(userMessageOf(error)); });
    return () => controller.abort();
  }, [load]);
  const editable = (role: Role) => !role.system && role.permissions.every(code => data?.grantable.includes(code));
  const toggle = (values: string[], key: string) => values.includes(key) ? values.filter(value => value !== key) : [...values, key];
  const reset = () => { setEditing(null); setName(''); setPermissions([]); setScope(pg ? 'all' : 'self'); };
  async function mutate(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown) {
    setBusy(true); setError(null); setNotice('');
    try {
      await apiRequest(path, { method, body, session });
      await load();
      notifyAccessChanged();
      setNotice('저장했습니다. 현재 세션의 접근 권한이 갱신됩니다.');
      return true;
    } catch (error) { setError(userMessageOf(error)); return false; }
    finally { setBusy(false); }
  }
  return <section className="screen role-settings">
    <header><Link to="/settings">설정</Link><h1>{screen.label}</h1><p>동작과 메뉴를 각각 선택하세요. 권한을 부여해도 꺼진 조직 기능은 켜지지 않습니다.</p></header>
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <p role="status">역할을 불러오는 중입니다…</p> : <>
      <section className="role-settings__card"><h2>등록된 역할</h2>
        <div className="role-settings__list">{data.items.map(role => <div key={role.key} data-testid={`role-${role.key}`}>
          <strong>{role.name}</strong><small>{role.system ? '기본 역할' : '사용자 정의'} · {role.scope} · 권한 {role.permissions.length}개</small>
          {editable(role) && <><Button tone="neutral" size="small" disabled={busy} onClick={() => { setEditing(role); setName(role.name); setScope(role.scope); setPermissions(role.permissions); }}>수정</Button>
            <Button tone="danger" size="small" disabled={busy} onClick={() => setDeleting(role.key)}>삭제</Button></>}
          {deleting === role.key && <div role="alert"><p>이 역할을 삭제하면 모든 배정이 즉시 해제됩니다.</p><Button tone="danger" disabled={busy} onClick={async () => { if (await mutate(`/settings/roles/${role.key}`, 'DELETE')) { setDeleting(null); reset(); } }}>삭제 확정</Button><Button tone="neutral" onClick={() => setDeleting(null)}>취소</Button></div>}
        </div>)}</div>
      </section>
      <form className="role-settings__card" onSubmit={async event => {
        event.preventDefault();
        if (await mutate(editing ? `/settings/roles/${editing.key}` : '/settings/roles', editing ? 'PATCH' : 'POST', { name, scope, permissions })) reset();
      }}><h2>{editing ? '역할 수정' : '역할 만들기'}</h2>
        <label>역할 이름<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>역할 위임 범위<select value={scope} disabled={pg} onChange={event => setScope(event.target.value)}>
          {(pg ? ['all'] : ['self', 'project', 'department', 'all'].slice(0, ['self', 'project', 'department', 'all'].indexOf(data.scope) + 1)).map(value => <option value={value} key={value}>{({ self: '본인', project: '참여 프로젝트', department: '부서', all: '회사 전체' } as Record<string, string>)[value]}</option>)}
        </select></label>
        <p>이 범위는 위임 가능한 역할의 상한입니다. 데이터는 회사 단위로 격리되며, 개별 화면의 기존 조회 정책이 적용됩니다.{pg ? ' PG 역할은 회사 전체 범위만 지원합니다.' : ''}</p>
        {data.items.find(role => role.key === 'company_admin')?.permissions.every(code => data.grantable.includes(code)) &&
          <Button type="button" tone="neutral" onClick={() => { setPermissions(data.items.find(role => role.key === 'company_admin')!.permissions); setScope('all'); }}>모든 회사 권한 선택</Button>}
        {(['menu', 'action'] as const).map(kind => <fieldset key={kind}><legend>{kind === 'menu' ? '접근 가능한 메뉴' : '실행 가능한 동작'}</legend>
          <div className="role-settings__checks">{data.catalog.filter(item => item.kind === kind).map(item => <label key={item.code}>
            <input type="checkbox" checked={permissions.includes(item.code)} disabled={!data.grantable.includes(item.code) || busy} onChange={() => setPermissions(toggle(permissions, item.code))} />
            <span>{item.label}<small>{item.code}</small></span>
          </label>)}</div></fieldset>)}
        <div className="role-settings__actions"><Button type="submit" disabled={busy}>{editing ? '역할 저장' : '역할 생성'}</Button>{editing && <Button type="button" tone="neutral" onClick={reset}>새 역할</Button>}</div>
      </form>
      <section className="role-settings__card"><h2>구성원 역할 배정</h2>
        <label>구성원<select value={memberId} onChange={event => { setMemberId(event.target.value); setAssigned(members.find(member => member.membership_id === event.target.value)?.roles ?? []); }}><option value="">구성원 선택</option>{members.map(member => <option key={member.membership_id} value={member.membership_id}>{member.name} ({member.email})</option>)}</select></label>
        {memberId && <><div className="role-settings__checks">{data.items.map(role => <label key={role.key}><input type="checkbox" checked={assigned.includes(role.key)} disabled={busy || !role.permissions.every(code => data.grantable.includes(code))} onChange={() => setAssigned(toggle(assigned, role.key))} />{role.name}</label>)}</div>
          <p>선택한 역할로 교체합니다. 모두 해제하면 이 회사의 역할이 회수됩니다. 마지막 관리자는 회수할 수 없습니다.</p>
          <Button disabled={busy} onClick={() => mutate(`/settings/members/${memberId}/roles`, 'PUT', { roles: assigned })}>역할 배정 저장</Button></>}
      </section>
    </>}
  </section>;
}
