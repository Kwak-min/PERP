import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import type { ScreenDefinition } from '../routes/catalog';
import { ApiError, apiRequest, userMessageOf, type ApiSession } from '../services/api';
import { useSession } from '../store/session';
import { notifyAccessChanged, useAccess } from '../hooks/useWorkspaceAccess';
import { Button } from '../components/ui/Button';
import { assignmentSchema, canDelegateRole, effectiveRoleSources, membersSchema, roleAccessSchema, roleSchema, roleScopeSchema, rolesSchema, scopeLabels, scopes, toggleRoleValue, type Member, type Role, type Roles } from './role-settings-model';
import { actionPermissionLabels } from './action-permission-labels';
import './role-settings.css';

const roleFeatureCatalog = [
  { key: 'attendance', label: '근태', includes: (code: string) => code === 'menu.attendance' || code.startsWith('attendance.') },
  { key: 'leave', label: '휴가', includes: (code: string) => code === 'menu.leave' || code.startsWith('leave.') },
] as const;

function RoleFeatureGrants({ role, enabledFeatures }: Readonly<{ role: Role; enabledFeatures: ReadonlySet<string> }>) {
  const grants = roleFeatureCatalog.map(feature => ({
    ...feature,
    count: role.permissions.filter(feature.includes).length,
    enabled: enabledFeatures.has(feature.key),
  })).filter(feature => feature.count > 0);
  if (grants.length === 0) return null;
  return <div className="role-settings__feature-grants" aria-label={`${role.name}의 근태 및 휴가 저장 권한`}>
    {grants.map(feature => <span key={feature.key} data-testid={`role-feature-${feature.key}`}>
      <strong>{feature.label} 저장 권한 {feature.count}개</strong>
      <small data-feature-status={feature.enabled ? 'enabled' : 'disabled'}>
        {feature.enabled ? '조직 기능 켜짐' : '조직 기능 꺼짐 · 권한과 자료는 보존됨'}
      </small>
    </span>)}
  </div>;
}

type Conflict = Readonly<{ kind: 'role' | 'member' | 'delete'; latest: Readonly<{ roles: Roles; members: Member[] }> | null }>;
export function RoleSettingsScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const stored = useSession();
  const session = useMemo(() => stored ? { token: stored.token, orgId: stored.orgId } : null, [stored?.token, stored?.orgId]);
  return session && <RoleEditor key={`${session.token}:${session.orgId}`} screen={screen} session={session} />;
}
function RoleEditor({ screen, session }: Readonly<{ screen: ScreenDefinition; session: ApiSession }>) {
  const pg = Boolean(session.orgId?.startsWith('pg:'));
  const access = useAccess();
  const enabledFeatures = new Set(access?.features ?? []);
  const [data, setData] = useState<Roles | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const [closed, setClosed] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Role['scope']>(pg ? 'all' : 'self');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [member, setMember] = useState<Member | null>(null);
  const [assigned, setAssigned] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const readLatest = useCallback(async (signal: AbortSignal) => {
    const [roles, people] = await Promise.all([apiRequest('/settings/roles', { session, signal }), apiRequest('/settings/members', { session, signal })]);
    return { roles: rolesSchema.parse(roles), members: membersSchema.parse(people).items };
  }, [session]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    readLatest(controller.signal).then(latest => { if (!controller.signal.aborted) { setData(latest.roles); setMembers(latest.members); } })
      .catch(error => { if (!controller.signal.aborted) setError(userMessageOf(error)); });
    return () => controller.abort();
  }, [readLatest]);
  const authorized = access && (access.permissions.includes('*') || access.permissions.includes('role.assign')) && (access.permissions.includes('*') || access.menus.includes('menu.roles'));
  const locked = busy || Boolean(conflict);
  const reset = () => { setEditing(null); setName(''); setPermissions([]); setScope(pg ? 'all' : 'self'); };
  const editable = (role: Role) => data && !role.system && canDelegateRole(role, data);
  const memberDelegable = data && member && member.roles.every(key => { const role = data.items.find(item => item.key === key); return role && canDelegateRole(role, data, true); });
  const adminPreset = data?.items.find(role => role.key === 'company_admin');
  async function mutate(kind: 'role' | 'member' | 'delete') {
    const signal = lifetime.current?.signal;
    if (!signal || pending.current || conflict) return;
    pending.current = true; setBusy(true); setError(null); setNotice('');
    let committed = false;
    try {
      switch (kind) {
        case 'role': {
          const payload = await apiRequest(editing ? `/settings/roles/${encodeURIComponent(editing.id)}` : '/settings/roles', {
            method: editing ? 'PATCH' : 'POST', session, signal, body: { name, scope, permissions, ...(editing ? { expected_version: editing.version } : {}) } });
          committed = true;
          const saved = roleSchema.parse(payload);
          if (signal.aborted) return;
          setEditing(saved); setName(saved.name); setScope(saved.scope); setPermissions(saved.permissions);
          break;
        }
        case 'member': {
          if (!member) return;
          const payload = await apiRequest(`/settings/members/${encodeURIComponent(member.membership_id)}/roles`, {
            method: 'PUT', session, signal, body: { roles: assigned, expected_roles_version: member.roles_version } });
          committed = true;
          const saved = assignmentSchema.parse(payload);
          if (signal.aborted) return;
          setMember({ ...member, ...saved }); setAssigned(saved.roles);
          break;
        }
        case 'delete': {
          if (!deleting) return;
          await apiRequest(`/settings/roles/${encodeURIComponent(deleting.id)}`, { method: 'DELETE', session, signal, body: { expected_version: deleting.version } });
          committed = true;
          if (signal.aborted) return;
          if (editing?.id === deleting.id) reset();
          setDeleting(null);
          break;
        }
        default: { const unreachable: never = kind; return unreachable; }
      }
      // 쓰기 성공과 후속 조회 실패는 별개다. 보호된 목록을 다시 읽기 전에 성공을 화면에 기록한다.
      flushSync(() => setNotice('저장했습니다. 현재 접근 권한을 확인합니다.'));
      const current = roleAccessSchema.parse(await apiRequest('/settings/access', { session, signal }));
      if (signal.aborted) return;
      const allowed = current.permissions.includes('*') || (current.permissions.includes('role.assign') && current.menus.includes('menu.roles'));
      if (!allowed) { setNotice('저장했습니다. 접근 권한을 갱신하고 편집을 종료했습니다.'); setClosed(true); reset(); setMember(null); setAssigned([]); }
      notifyAccessChanged();
      if (allowed) {
        const latest = await readLatest(signal);
        if (!signal.aborted) { setData(latest.roles); setMembers(latest.members); setNotice('저장했습니다. 접근 권한을 갱신했습니다.'); }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (committed) setError('저장은 완료됐지만 최신 상태 확인에 실패했습니다. 다시 저장하지 말고 화면을 새로 열어 확인하세요.');
      else {
        setError(userMessageOf(error));
        if (error instanceof ApiError && error.status === 409) setConflict({ kind, latest: null });
      }
      if (error instanceof ApiError && error.status === 403) { setClosed(true); notifyAccessChanged(); }
    } finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  }
  async function compareLatest() {
    const signal = lifetime.current?.signal;
    if (!signal || !conflict || pending.current) return;
    pending.current = true; setBusy(true);
    try { const latest = await readLatest(signal); if (!signal.aborted) { setConflict({ ...conflict, latest }); setData(latest.roles); setMembers(latest.members); } }
    catch (error) { if (!signal.aborted) { setError(userMessageOf(error)); if (error instanceof ApiError && error.status === 403) { setClosed(true); notifyAccessChanged(); } } }
    finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  }
  const latestRole = conflict?.latest?.roles.items.find(role => role.id === (conflict.kind === 'delete' ? deleting?.id : editing?.id));
  const latestMember = conflict?.latest?.members.find(item => item.membership_id === member?.membership_id);
  const creatingConflict = conflict?.kind === 'role' && !editing;
  const draftRole = conflict?.kind === 'delete' ? deleting : { name, scope, permissions };
  const comparisonReady = conflict?.kind === 'member' ? Boolean(latestMember) : creatingConflict ? Boolean(conflict?.latest) : Boolean(latestRole);
  const sources = data && member ? effectiveRoleSources(data, member.roles) : [];
  return <section className="screen role-settings" aria-busy={busy}>
    <header><Link to="/settings">설정</Link><h1>{screen.label}</h1><p>메뉴 접근, 업무 동작, 역할 위임을 따로 선택하고 저장하세요. 꺼진 조직 기능은 켜지지 않습니다.</p></header>
    {notice && <p role="status" data-testid="role-save-receipt">{notice}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {closed || !authorized ? <p role="alert" data-testid="role-editor-closed">현재 역할·권한 관리 권한이 없어 편집을 종료했습니다.</p> : !data ? <p role="status">역할을 불러오는 중입니다…</p> : <>
      {data.recovery_required && <p role="alert">활성 회사 전체 관리자가 없습니다. 관리자 복구가 필요하며 권한을 자동으로 부여하지 않습니다.</p>}
      {conflict && <section className="role-settings__card" data-testid="role-conflict"><h2>저장 충돌 · 초안 보존</h2><p>다른 변경 또는 관리자 보호로 저장되지 않았습니다. 최신값과 비교한 뒤 새로 저장하세요. 자동 재시도하지 않습니다.</p>
        <Button tone="neutral" disabled={busy} onClick={compareLatest}>최신값 비교</Button>
        {conflict.latest && <><div className="role-settings__comparison" data-testid="role-comparison">
          <div><h3>{conflict.kind === 'delete' ? '삭제할 역할' : '내 초안'}</h3><p>{conflict.kind === 'member' ? assigned.join(', ') || '역할 없음' : draftRole && `${draftRole.name} · ${scopeLabels[draftRole.scope]}`}</p>{conflict.kind !== 'member' && <p>{draftRole?.permissions.join(', ') || '권한 없음'}</p>}</div>
          <div><h3>최신 저장값</h3>{conflict.kind === 'member' ? <p>{latestMember ? `v${latestMember.roles_version} · ${latestMember.roles.join(', ') || '역할 없음'}` : '활성 구성원이 아니거나 목록에서 제거됐습니다.'}</p>
            : creatingConflict ? <p>{conflict.latest.roles.items.map(role => `${role.name} (v${role.version})`).join(', ')}</p> : <><p>{latestRole ? `v${latestRole.version} · ${latestRole.name} · ${scopeLabels[latestRole.scope]}` : '역할이 삭제됐습니다.'}</p><p>{latestRole?.permissions.join(', ')}</p></>}</div>
        </div><Button disabled={busy || !comparisonReady} onClick={() => {
          if (conflict.kind === 'member' && latestMember) setMember(latestMember);
          else if (conflict.kind === 'delete' && latestRole) setDeleting(latestRole);
          else if (latestRole) setEditing(latestRole);
          setConflict(null); setError(null);
        }}>비교 확인 · 초안 유지</Button></>}
        <Button tone="neutral" disabled={busy} onClick={() => { setConflict(null); setDeleting(null); reset(); setMember(null); setAssigned([]); setError(null); }}>초안 버리기</Button>
      </section>}
      <section className="role-settings__card"><h2>등록된 역할</h2><p>여러 역할의 권한은 합집합입니다. 하나를 끄더라도 다른 역할이 같은 권한을 주면 유지됩니다.</p>
        <div className="role-settings__list">{data.items.map(role => <div key={role.key} data-testid={`role-${role.key}`}>
          <strong>{role.name}</strong><small>{role.system ? '기본 역할' : '사용자 정의'} · {scopeLabels[role.scope]} · 권한 {role.permissions.length}개 · v{role.version}</small>
          {editable(role) && <><Button tone="neutral" size="small" disabled={locked} onClick={() => { setEditing(role); setName(role.name); setScope(role.scope); setPermissions(role.permissions); }}>수정</Button>
            <Button tone="danger" size="small" disabled={locked} onClick={() => setDeleting(role)}>삭제</Button></>}
          <RoleFeatureGrants role={role} enabledFeatures={enabledFeatures} />
          {deleting?.id === role.id && <div role="alert"><p>이 역할을 삭제하면 모든 배정이 해제됩니다. v{deleting.version} 기준으로 삭제합니다.</p><Button tone="danger" disabled={locked} onClick={() => mutate('delete')}>삭제 확정</Button><Button tone="neutral" disabled={locked} onClick={() => setDeleting(null)}>취소</Button></div>}
        </div>)}</div>
      </section>
      <form className="role-settings__card" data-testid="role-definition-editor" data-version={editing?.version ?? 'new'} onSubmit={event => { event.preventDefault(); void mutate('role'); }}>
        <h2>{editing ? '역할 수정' : '역할 만들기'}</h2><p>{editing ? `기준 버전 v${editing.version}` : '새 역할'} · 아래 선택은 저장 전까지 적용되지 않습니다.</p>
        <p className="role-settings__feature-note">
          근태·휴가 체크는 역할에 저장할 권한입니다. 조직 기능이 꺼져 있어도 편집할 수 있으며,
          여기서 권한을 바꿔도 조직 기능은 켜지지 않습니다.
        </p>
        <label>역할 이름<input required maxLength={80} disabled={locked} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>역할 위임 범위<select value={scope} disabled={locked || pg} onChange={event => setScope(roleScopeSchema.parse(event.target.value))}>
          {(pg ? ['all'] as const : scopes.slice(0, scopes.indexOf(data.scope) + 1)).map(value => <option value={value} key={value}>{scopeLabels[value]}</option>)}
        </select></label>
        <p>본인의 권한과 범위 안에서만 위임합니다. 회사 간 접근이나 개인 자료 소유권을 우회하지 않습니다.{pg ? ' PG 역할은 회사 전체 범위만 지원합니다.' : ''}</p>
        {adminPreset && <Button type="button" tone="neutral" disabled={locked || !canDelegateRole(adminPreset, data)} onClick={() => { setPermissions([...adminPreset.permissions]); setScope('all'); }}>관리자 프리셋 · 모든 회사 권한 선택</Button>}
        {(['menu', 'action', 'delegation'] as const).map(kind => <fieldset key={kind} data-permission-kind={kind}><legend>{kind === 'menu' ? '접근 가능한 메뉴' : kind === 'action' ? '실행 가능한 업무 동작' : '역할·권한 관리'}</legend>
          {kind === 'delegation' && <p>역할 정의 생성·변경·삭제와 구성원 배정·회수를 허용합니다. 메뉴 접근(menu.roles)과 별개이며 구성원 경로의 위임에도 필요합니다.</p>}
          <div className="role-settings__checks">{data.catalog.filter(item => kind === 'delegation' ? item.code === 'role.assign' : item.kind === kind && item.code !== 'role.assign').map(item => {
            const feature = roleFeatureCatalog.find(feature => feature.includes(item.code));
            return <label key={item.code}>
              <input type="checkbox" data-permission={item.code} aria-labelledby={`permission-label-${item.code}`} aria-describedby={`permission-code-${item.code}`} checked={permissions.includes(item.code)} disabled={locked || !data.grantable.includes(item.code)} onChange={() => setPermissions(toggleRoleValue(permissions, item.code))} />
              <span><span id={`permission-label-${item.code}`}>{actionPermissionLabels[item.code] ?? item.label}</span><small id={`permission-code-${item.code}`} data-feature-status={feature ? enabledFeatures.has(feature.key) ? 'enabled' : 'disabled' : undefined}>
                {item.code}{feature ? ` · 조직 기능 ${enabledFeatures.has(feature.key) ? '켜짐' : '꺼짐 (저장 권한 유지)'}` : ''}
              </small></span>
            </label>;
          })}</div>
        </fieldset>)}
        <div className="role-settings__actions"><Button type="submit" disabled={locked || Boolean(editing && !editable(editing))}>{editing ? '역할 저장' : '역할 생성'}</Button>{editing && <Button type="button" tone="neutral" disabled={locked} onClick={reset}>새 역할</Button>}</div>
      </form>
      <section className="role-settings__card" data-testid="role-membership-editor" data-version={member?.roles_version}><h2>구성원 역할 배정</h2>
        <label>구성원<select value={member?.membership_id ?? ''} disabled={locked} onChange={event => { const selected = members.find(item => item.membership_id === event.target.value) ?? null; setMember(selected); setAssigned(selected?.roles ?? []); }}><option value="">구성원 선택</option>{members.map(item => <option key={item.membership_id} value={item.membership_id}>{item.name} ({item.email})</option>)}</select></label>
        {member && <><p>활성 구성원 · 배정 기준 v{member.roles_version} · 역할 또는 활성 상태 변경 시 이 버전이 바뀝니다.</p>
          <div className="role-settings__checks">{data.items.map(role => <label key={role.key}><input type="checkbox" data-role-key={role.key} checked={assigned.includes(role.key)} disabled={locked || !memberDelegable || !canDelegateRole(role, data, role.key === 'owner' && assigned.includes(role.key))} onChange={() => setAssigned(toggleRoleValue(assigned, role.key))} />{role.name}</label>)}</div>
          {!memberDelegable && <p>기존 역할이 본인의 위임 범위를 넘어 이 구성원의 역할을 교체할 수 없습니다.</p>}
          <p>선택한 역할로 교체합니다. 모두 해제하면 이 회사의 역할이 회수됩니다. 마지막 활성 회사 전체 관리자는 회수할 수 없습니다.</p>
          <Button disabled={locked || !memberDelegable} onClick={() => mutate('member')}>역할 배정 저장</Button>
          <details className="role-settings__sources"><summary>저장된 유효 권한과 출처 · {sources.length}개</summary><p>선택 초안이 아닌 현재 읽은 역할 배정의 합집합입니다. 꺼진 기능의 권한도 보존됩니다.</p>
            <ul>{sources.map(item => <li key={item.code} data-effective-permission={item.code}><strong>{actionPermissionLabels[item.code] ?? item.label}</strong><small>{item.code} · {item.sources.join(' + ')}</small></li>)}</ul>
          </details></>}
      </section>
    </>}
  </section>;
}
