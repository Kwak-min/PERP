import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useModalFocus } from '../../hooks/useModalFocus';
import { apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { Button } from '../ui/Button';
import { AssigneeSelect } from './AssigneeSelect';
const assetSchema = z.object({ name: z.string(), version: z.number().int().positive(), status: z.string(),
  category: z.string().nullable().optional(), location: z.string().nullable().optional(), assignee_id: z.string().nullable().optional(), custodian_id: z.string().nullable().optional() });
const grantsSchema = z.object({ permissions: z.array(z.string()) });
const workspaceSchema = z.object({ organizations: z.array(grantsSchema.extend({ org_id: z.string() })) });
const pgStates = [{ value: 'in_use', label: '사용 중' }, { value: 'stored', label: '보관' }, { value: 'repair', label: '수리' }, { value: 'lost', label: '분실' }, { value: 'disposed', label: '폐기' }];
const legacyStates = [{ value: 'available', label: '사용 가능' }, { value: 'loaned', label: '대여 중' }, { value: 'repairing', label: '수리' }, { value: 'damaged', label: '파손' }, { value: 'lost', label: '분실' }, { value: 'disposed', label: '폐기' }];

export function AssetCustodyModal({ id, session, onClose, onSaved }: Readonly<{ id: string; session: ApiSession; onClose: () => void; onSaved: () => void }>) {
  const pg = isPgWorkspace(session.orgId);
  const [asset, setAsset] = useState<z.infer<typeof assetSchema> | null>(null);
  const [assignee, setAssignee] = useState(''), [status, setStatus] = useState('');
  const [name, setName] = useState(''), [category, setCategory] = useState(''), [location, setLocation] = useState('');
  const [canWrite, setCanWrite] = useState(false), [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!saving && (!dirty || window.confirm('입력한 내용이 사라집니다. 닫을까요?'))) onClose(); };
  const ref = useModalFocus<HTMLFormElement>(close, true);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([apiRequest(`${pg ? '/pg' : ''}/assets/${encodeURIComponent(id)}${pg ? '/custody' : ''}`, { session, signal: controller.signal }),
      apiRequest(pg ? '/pg/auth/workspace' : '/tenants/current', { session, signal: controller.signal })]).then(([payload, permissions]) => {
      const row = assetSchema.parse(payload), grants = pg ? workspaceSchema.parse(permissions).organizations.find(org => org.org_id === session.orgId)?.permissions ?? [] : grantsSchema.parse(permissions).permissions;
      if (!controller.signal.aborted) { setAsset(row); setName(row.name); setCategory(row.category ?? ''); setLocation(row.location ?? ''); setAssignee((pg ? row.assignee_id : row.custodian_id) ?? ''); setStatus(row.status); setCanWrite(grants.includes('asset.write') || (!pg && grants.includes('*'))); }
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [id, pg, session]);
  async function submit(): Promise<void> {
    if (!asset) return;
    setSaving(true); setError(null);
    try {
      await apiRequest(`${pg ? '/pg' : ''}/assets/${encodeURIComponent(id)}/custody`, { method: 'PATCH', session, body: { version: asset.version, status, ...(pg ? { name: name.trim(), category: category || null, location: location || null } : {}),
        ...(assignee !== ((pg ? asset.assignee_id : asset.custodian_id) ?? '') ? (pg ? { assignee_id: assignee || null } : { custodian_id: assignee || null }) : {}) } });
      onSaved(); onClose();
    } catch (caught: unknown) { setError(userMessageOf(caught)); setSaving(false); }
  }
  return <div className="modal-scrim" role="presentation" onMouseDown={close}><form ref={ref} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="asset-custody-title" onMouseDown={event => event.stopPropagation()} onChange={() => setDirty(true)} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <header className="modal__head"><h2 id="asset-custody-title">자산 담당·상태 변경</h2><Button type="button" tone="neutral" disabled={saving} onClick={close}>닫기</Button></header>
    {asset ? <div className="form-stack"><strong>{asset.name}</strong><p>변경 이력은 보관됩니다. 폐기 후에는 변경할 수 없습니다.</p>
      {pg && <><label>이름<input required maxLength={200} value={name} disabled={saving || !canWrite || asset.status === 'disposed'} onChange={event => setName(event.target.value)} /></label>
        <label>분류<input value={category} disabled={saving || !canWrite || asset.status === 'disposed'} onChange={event => setCategory(event.target.value)} /></label>
        <label>위치<input value={location} disabled={saving || !canWrite || asset.status === 'disposed'} onChange={event => setLocation(event.target.value)} /></label></>}
      <AssigneeSelect session={session} value={assignee} onChange={setAssignee} disabled={saving || !canWrite || asset.status === 'disposed'} />
      <label>상태<select aria-label="상태" value={status} disabled={saving || !canWrite || asset.status === 'disposed'} onChange={event => setStatus(event.target.value)}>{(pg ? pgStates : legacyStates).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      {!canWrite && <p role="status">자산 변경 권한이 없습니다.</p>}</div> : !error && <p role="status">자산을 불러오는 중</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
    <footer className="modal__foot"><Button type="button" tone="neutral" disabled={saving} onClick={close}>취소</Button><Button type="submit" disabled={!asset || !canWrite || saving || asset.status === 'disposed'}>{saving ? '저장 중' : '저장'}</Button></footer>
  </form></div>;
}
