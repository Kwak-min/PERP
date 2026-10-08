import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';
import { useModalFocus } from '../../hooks/useModalFocus';
import { useAccess, type WorkspaceAccess } from '../../hooks/useWorkspaceAccess';
import { sessionStore } from '../../store/session';
import { Button } from '../ui/Button';
import { MarkdownView } from '../../screens/vault/MarkdownView';
import { homeCategories, homeCategoryAllowed, homeDocumentSchema, homeListEndpoint, homeUsageSchema, parseHomeRows, type HomeCategory, type HomeRow, type HomeSelection } from './homeDetailModel';
import './home-detail-modal.css';

type Props = Readonly<{ initial: HomeSelection; session: ApiSession; onClose: () => void }>;
type Load<T> = { status: 'loading' | 'ready' | 'empty' | 'forbidden' | 'error'; data: T | null; error: string | null };

// 호출부 key는 회사·세션·권한·범주·항목 변경 시 이전 내용을 동기적으로 버린다.
function useHomePayload<T>(endpoint: string, session: ApiSession, parse: (payload: unknown) => T, revision: number): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: 'loading', data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });
    apiRequest(endpoint, { session, signal: controller.signal }).then(payload => {
      const data = parse(payload);
      if (!controller.signal.aborted) setState({ status: Array.isArray(data) && !data.length ? 'empty' : 'ready', data, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) sessionStore.clear();
      setState({ status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error', data: null, error: userMessageOf(error) });
    });
    return () => controller.abort();
  }, [endpoint, session, parse, revision]);
  return state;
}

function LoadMessage({ status, error, retry }: Readonly<{ status: Load<unknown>['status']; error: string | null; retry: () => void }>) {
  if (status === 'ready') return null;
  return <div className="home-detail__state" role={status === 'error' || status === 'forbidden' ? 'alert' : 'status'}>
    <strong>{status === 'loading' ? '목록을 불러오는 중입니다' : status === 'empty' ? '조회 가능한 항목이 없습니다' : status === 'forbidden' ? '이 목록을 볼 권한이 없습니다' : '데이터를 불러오지 못했습니다'}</strong>
    {error && <p>{error}</p>}
    {status === 'error' && <Button tone="neutral" onClick={retry}>다시 시도</Button>}
  </div>;
}

export function HomeDetailModal({ initial, session, onClose }: Props) {
  const access = useAccess();
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const [selection, setSelection] = useState<HomeSelection>(initial);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  const permissionKey = JSON.stringify(access);
  return <div className="modal-scrim home-detail-scrim" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) {
      // 기본 mousedown 포커스 이동이 닫기 후 복원된 트리거 포커스를 덮지 않게 한다.
      event.preventDefault();
      onClose();
    }
  }}>
    <div ref={dialogRef} className="modal home-detail-modal" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="home-detail-title">
      <header className="modal__head">
        <div><span className="eyebrow">HOME</span><h2 id="home-detail-title">{selection === 'overview' ? '홈 현황' : `${homeCategories.find(item => item.key === selection)!.label} 목록`}</h2>
          <p>선택한 회사에서 조회 권한이 있는 서버 데이터입니다.</p></div>
        <Button tone="neutral" size="small" onClick={onClose} aria-label="홈 자세히 닫기">닫기</Button>
      </header>
      <nav className="home-detail__nav" aria-label="홈 상세 범주">
        <Button tone="ghost" aria-pressed={selection === 'overview'} onClick={() => setSelection('overview')}>현황</Button>
        {homeCategories.map(item => <Button key={item.key} tone="ghost" aria-pressed={selection === item.key} onClick={() => setSelection(item.key)}>{item.label}</Button>)}
      </nav>
      <div key={`${session.token}:${session.orgId}:${permissionKey}:${selection}`}>
        {selection === 'overview' ? <HomeOverview session={session} onSelect={setSelection} />
          : !access ? <LoadMessage status="loading" error={null} retry={() => {}} />
          : <CategoryGate category={selection} session={session} access={access} onClose={onClose} />}
      </div>
    </div>
  </div>;
}

const parseUsage = (payload: unknown) => homeUsageSchema.parse(payload);
function HomeOverview({ session, onSelect }: Readonly<{ session: ApiSession; onSelect: (category: HomeCategory) => void }>) {
  const [revision, setRevision] = useState(0);
  const state = useHomePayload('/pg/usage', session, parseUsage, revision);
  const counts = state.data;
  return <div data-home-overview={state.status}>
    <LoadMessage status={state.status} error={state.error} retry={() => setRevision(value => value + 1)} />
    {counts && <><div className="home-detail__overview">{homeCategories.map(item => <Button key={item.key} tone="neutral" onClick={() => onSelect(item.key)} aria-label={`${item.label} 목록 열기`}>
      <span>{item.label}</span><strong>{counts[item.key].toLocaleString('ko-KR')}</strong>
    </Button>)}</div><p className="home-detail__note">홈 집계 응답 기준입니다. 삭제·활성 상태와 문서 공개 범위에 따라 상세 목록의 조회 건수와 다를 수 있습니다.</p></>}
  </div>;
}

function CategoryGate({ category, session, access, onClose }: Readonly<{ category: HomeCategory; session: ApiSession; access: WorkspaceAccess; onClose: () => void }>) {
  if (!homeCategoryAllowed(access, category)) return <div data-home-category={category} data-state="forbidden"><LoadMessage status="forbidden" error="필요한 메뉴·조회 권한 또는 모듈이 없습니다. 조직 관리자에게 문의하세요." retry={() => {}} /></div>;
  return <HomeList category={category} session={session} onClose={onClose} />;
}

function HomeList({ category, session, onClose }: Readonly<{ category: HomeCategory; session: ApiSession; onClose: () => void }>) {
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<HomeRow | null>(null);
  const parse = useMemo(() => (payload: unknown) => parseHomeRows(payload, category, isPgWorkspace(session.orgId)), [category, session.orgId]);
  const state = useHomePayload(homeListEndpoint(category, session.orgId), session, parse, revision);
  const rows = state.data ?? [];
  const filtered = rows.filter(row => [row.name, ...row.facts.map(([, value]) => value)].some(value => value.toLocaleLowerCase('ko-KR').includes(query.trim().toLocaleLowerCase('ko-KR'))));
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * 10, current * 10);
  return <section data-home-category={category} data-state={state.status} aria-label="조회 목록">
    <LoadMessage status={state.status} error={state.error} retry={() => { setSelected(null); setRevision(value => value + 1); }} />
    {state.status === 'ready' && <>
      <div className="home-detail__toolbar"><label>목록 검색<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1); setSelected(null); }} /></label>
        <span data-home-total={rows.length}>조회 {rows.length}건 · 검색 {filtered.length}건</span></div>
      {!filtered.length ? <p role="status">검색 조건에 맞는 항목이 없습니다.</p> : <div className="table-wrap" role="region" aria-label="홈 상세 표" tabIndex={0}><table>
        <thead><tr><th>{category === 'members' ? '이름' : '제목'}</th><th>{rows[0]?.facts[0]?.[0]}</th><th>{rows[0]?.facts[1]?.[0]}</th></tr></thead>
        <tbody>{visible.map(row => <tr key={row.id} data-home-row={row.id}><td><Button tone="ghost" onClick={() => setSelected(row)} aria-expanded={selected?.id === row.id}>{row.name}</Button></td>
          <td>{row.facts[0]?.[1]}</td><td>{row.facts[1]?.[1]}</td></tr>)}</tbody>
      </table></div>}
      <nav className="home-detail__pager" aria-label="홈 상세 페이지"><Button tone="neutral" disabled={current === 1} onClick={() => { setPage(current - 1); setSelected(null); }}>이전</Button>
        <span role="status">{current} / {pages} 페이지</span><Button tone="neutral" disabled={current === pages} onClick={() => { setPage(current + 1); setSelected(null); }}>다음</Button></nav>
      {selected && <section className="home-detail__record" data-home-detail={selected.id} aria-label={`${selected.name} 상세`}>
        <h3>{selected.name}</h3><dl>{selected.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {selected.href && <Link to={selected.href} onClick={onClose}>원본 화면에서 열기</Link>}
        {category === 'documents' && <HomeDocument key={selected.id} id={selected.id} session={session} />}
      </section>}
    </>}
  </section>;
}

function HomeDocument({ id, session }: Readonly<{ id: string; session: ApiSession }>) {
  const [revision, setRevision] = useState(0);
  const parse = useMemo(() => (payload: unknown) => {
    const document = homeDocumentSchema.parse(payload);
    if (document.id !== id) throw new Error('문서 식별자가 응답과 다릅니다.');
    return document;
  }, [id]);
  const state = useHomePayload(`/pg/documents/${encodeURIComponent(id)}`, session, parse, revision);
  return <div data-home-document-state={state.status}><LoadMessage status={state.status} error={state.error} retry={() => setRevision(value => value + 1)} />
    {state.data && <><h4>문서 본문 · v{state.data.version}</h4>{state.data.content ? <MarkdownView source={state.data.content} /> : <p>본문이 비어 있습니다.</p>}</>}
  </div>;
}
