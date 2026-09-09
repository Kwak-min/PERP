import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { matchPath, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAppContext } from "../../context/AppContext";
import { AccessContext, canOpenScreen, useWorkspaceAccess } from '../../hooks/useWorkspaceAccess';
import { navigation, screens, sectionLabels, type ScreenSection } from "../../routes/catalog";
import { authenticatedUserId, logout as revokeSession } from "../../services/auth";
import { userMessageOf } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { NAV_PREF_NOTICE, navPrefKey, readNavPref, selectNavFavorites, updateNavPref, type NavPref, type NavPrefScope } from "../../store/navPref";
import { sessionStore, useSession } from "../../store/session";
import { Button } from "../ui/Button";
import { AgentPanel } from "./AgentPanel";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const mobilePaths = ['/', '/projects', '/calendar', '/settings'];
const sidebarMedia = '(max-width: 1100px)';
const canFocus = (node: HTMLElement) => node.isConnected && !node.closest('[inert]') && !node.matches(':disabled') && node.checkVisibility({ visibilityProperty: true });
const sidebarControls = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
  .filter(node => node.tabIndex >= 0 && canFocus(node));
const emptyNavPref: NavPref = { version: 1, favoriteScreenIds: [], collapsedSectionIds: [] };
type NavState = Readonly<{ key: string; status: 'loading' | 'ready' | 'unavailable'; value: NavPref; error: string | null }>;

function storageMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return '브라우저 저장 공간이 부족해 메뉴 설정을 저장하지 못했습니다.';
  if (error instanceof DOMException && error.name === 'SecurityError') return '브라우저 저장소 접근이 차단되어 메뉴 설정을 사용할 수 없습니다.';
  return '메뉴 설정을 이 브라우저에 저장하지 못했습니다.';
}

export function AppShell() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarOpen, setSidebarOpen, toggleAgent } = useAppContext();
  const [responsiveSidebar, setResponsiveSidebar] = useState(() => window.matchMedia(sidebarMedia).matches);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarOpener = useRef<HTMLButtonElement | null>(null);
  const sidebarFocused = useRef<HTMLElement | null>(null);
  const modalSidebar = responsiveSidebar && sidebarOpen;
  const [search, setSearch] = useState("");
  const [identity, setIdentity] = useState<Readonly<{ token: string; userId: string | null; error: string | null }>>({ token: '', userId: null, error: null });
  const [navState, setNavState] = useState<NavState>({ key: '', status: 'loading', value: emptyNavPref, error: null });
  const access = useWorkspaceAccess(session, location.pathname);

  useLayoutEffect(() => {
    const media = window.matchMedia(sidebarMedia);
    const onChange = () => { setResponsiveSidebar(media.matches); setSidebarOpen(false); };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [setSidebarOpen]);

  useEffect(() => { setSidebarOpen(false); }, [location.pathname, setSidebarOpen]);

  useLayoutEffect(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    const frame = panel.parentElement!;
    const restore = () => {
      const opener = sidebarOpener.current ?? frame.querySelector<HTMLElement>('.menu-button');
      const target = opener && canFocus(opener) ? opener : frame.querySelector<HTMLElement>('#main-content');
      if (target && canFocus(target)) target.focus();
    };
    if (!modalSidebar) {
      // A focused desktop control must not disappear offscreen after a breakpoint change.
      if (responsiveSidebar && panel.contains(document.activeElement)) restore();
      return;
    }
    // Only this shell's covered siblings are inert; no document-wide keyboard interception.
    const background = [...frame.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== panel && !node.classList.contains('sidebar-scrim'));
    const previous = background.map(node => ({ node, inert: node.inert }));
    background.forEach(node => { node.inert = true; });
    (sidebarControls(panel)[0] ?? panel).focus();
    return () => {
      previous.forEach(({ node, inert }) => { node.inert = inert; });
      if (window.matchMedia(sidebarMedia).matches) restore();
      else if (panel.contains(document.activeElement) && !canFocus(document.activeElement as HTMLElement)) {
        (sidebarControls(panel)[0] ?? panel).focus();
      }
    };
  }, [modalSidebar, responsiveSidebar, Boolean(session)]);

  useLayoutEffect(() => {
    const panel = sidebarRef.current, focused = sidebarFocused.current;
    // A permission refresh is not a close/open cycle. Recover only a lost control,
    // never a live focus position or focus intentionally moved to another surface.
    if (panel && canFocus(panel) && focused && !canFocus(focused)
      && (document.activeElement === document.body || document.activeElement === focused)) {
      (sidebarControls(panel)[0] ?? panel).focus();
    }
  }, [access.data]);

  useEffect(() => {
    if (!session) return;
    const token = session.token;
    const controller = new AbortController();
    setIdentity({ token, userId: null, error: null });
    authenticatedUserId(token, controller.signal).then(userId => {
      if (!controller.signal.aborted) setIdentity({ token, userId, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setIdentity({ token, userId: null, error: userMessageOf(error) });
    });
    return () => controller.abort();
  }, [session?.token]);

  const userId = session && identity.token === session.token ? identity.userId : null;
  const scope: NavPrefScope | null = session?.orgId && userId ? {
    userId,
    source: isPgWorkspace(session.orgId) ? 'pg' : 'legacy',
    orgId: session.orgId,
  } : null;
  const scopeKey = scope ? navPrefKey(scope) : '';

  useEffect(() => {
    if (!scope || !access.data) return;
    const key = navPrefKey(scope);
    const sync = () => {
      const read = readNavPref(scope);
      if (read.status === 'unavailable') {
        setNavState({ key, status: 'unavailable', value: read.value, error: storageMessage(read.error) });
      } else {
        setNavState({ key, status: 'ready', value: read.value, error: read.status === 'invalid' ? '저장된 메뉴 설정이 손상되어 기본값으로 열었습니다.' : null });
      }
    };
    sync();
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) sync(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [access.data, scope?.orgId, scope?.source, scope?.userId]);

  if (!session) return null;
  const activeSession = session;
  const accessData = access.data;
  const visibleNavigation = accessData ? navigation.filter(screen => canOpenScreen(accessData, screen)) : [];
  const currentScreen = screens.filter(screen => matchPath({ path: screen.path, end: true }, location.pathname))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const allowed = Boolean(accessData && currentScreen && canOpenScreen(accessData, currentScreen));
  const canOpen = (path: string) => Boolean(accessData && screens.some(screen => screen.path === path && canOpenScreen(accessData, screen)));
  const activePath = visibleNavigation.reduce((active, screen) =>
    matchPath({ path: screen.path, end: screen.path === "/" }, location.pathname) && screen.path.length > active.length ? screen.path : active, "");
  const activeSection = visibleNavigation.find(screen => screen.path === activePath)?.section;
  const grouped = Object.entries(visibleNavigation.reduce<Record<string, typeof navigation>>((groups, screen) => {
    const current = groups[screen.section] ?? [];
    return { ...groups, [screen.section]: [...current, screen] };
  }, {}));
  const prefReady = Boolean(scope && access.data && navState.key === scopeKey && navState.status === 'ready');
  const pref = prefReady ? navState.value : emptyNavPref;
  const favorites = selectNavFavorites(pref, visibleNavigation);
  const prefStatus = !scope || !access.data || navState.key !== scopeKey ? 'loading' : navState.status;
  const prefError = identity.token === session.token && identity.error ? `메뉴 개인화 신원을 확인하지 못했습니다. ${identity.error}` : navState.key === scopeKey ? navState.error : null;

  function savePreference(update: (current: NavPref) => NavPref): void {
    if (!scope || !prefReady) return;
    try {
      const value = updateNavPref(scope, update);
      setNavState({ key: scopeKey, status: 'ready', value, error: null });
    } catch (error) {
      setNavState(current => current.key === scopeKey ? { ...current, error: storageMessage(error) } : current);
    }
  }

  function toggleFavorite(screenId: string): void {
    savePreference(current => ({ ...current, favoriteScreenIds: current.favoriteScreenIds.includes(screenId)
      ? current.favoriteScreenIds.filter(id => id !== screenId) : [...current.favoriteScreenIds, screenId] }));
  }

  function moveFavorite(screenId: string, offset: -1 | 1): void {
    const visibleIndex = favorites.findIndex(screen => screen.id === screenId);
    const targetId = favorites[visibleIndex + offset]?.id;
    if (!targetId) return;
    savePreference(current => ({ ...current, favoriteScreenIds: current.favoriteScreenIds.map(id =>
      id === screenId ? targetId : id === targetId ? screenId : id),
    }));
  }

  function toggleSection(section: ScreenSection): void {
    savePreference(current => ({ ...current, collapsedSectionIds: current.collapsedSectionIds.includes(section)
      ? current.collapsedSectionIds.filter(id => id !== section) : [...current.collapsedSectionIds, section] }));
  }

  async function logout(): Promise<void> {
    try { await revokeSession(activeSession.token, activeSession.orgId); }
    finally { sessionStore.clear(); navigate("/login"); }
  }

  return (
    <AccessContext.Provider value={access.data}>
    <div className="app-frame">
      <button className={`sidebar-scrim ${modalSidebar ? "sidebar-scrim--open" : ""}`} tabIndex={-1} aria-hidden="true" aria-label="메뉴 닫기" onClick={() => setSidebarOpen(false)} />
      <div ref={sidebarRef} id="app-sidebar" className={`sidebar ${modalSidebar ? "sidebar--open" : ""}`} role={modalSidebar ? 'dialog' : 'complementary'} aria-label="주 메뉴" aria-modal={modalSidebar ? true : undefined} inert={responsiveSidebar && !sidebarOpen} hidden={responsiveSidebar && !sidebarOpen} tabIndex={-1}
        onFocusCapture={event => { sidebarFocused.current = event.target; }}
        onBlurCapture={event => {
          if (canFocus(event.target) && !event.currentTarget.contains(event.relatedTarget)) sidebarFocused.current = null;
        }}
        onKeyDown={event => {
          if (!modalSidebar || event.defaultPrevented) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSidebarOpen(false); }
          if (event.key !== 'Tab') return;
          const controls = sidebarControls(event.currentTarget);
          const first = controls[0], last = controls.at(-1);
          if (!first) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
        }}>
        <div className="sidebar__brand"><WorkspaceSwitcher session={activeSession} /></div>
        <nav aria-label="주 메뉴">
          {favorites.length > 0 && <section className="nav-favorites" data-testid="nav-favorites" data-order={favorites.map(screen => screen.id).join(',')} aria-labelledby="nav-favorites-label">
            <p id="nav-favorites-label">즐겨찾기</p>
            {favorites.map((screen, index) => <div className="nav-entry nav-entry--favorite" key={screen.id}>
              <NavLink to={screen.path} end={screen.path !== activePath} data-screen-id={screen.id} onClick={() => setSidebarOpen(false)} className={({ isActive }) => isActive ? "active" : ""}>
                <span className="nav-mark" aria-hidden="true">{screen.label.slice(0, 1)}</span><span className="nav-label">{screen.label}</span>{screen.ai && <span className="nav-ai">AI</span>}
              </NavLink>
              <button type="button" className="nav-pref-control" onClick={() => moveFavorite(screen.id, -1)} disabled={!prefReady || index === 0} aria-label={`${screen.label} 위로 이동`} title={`${screen.label} 위로 이동`}><span aria-hidden="true">↑</span></button>
              <button type="button" className="nav-pref-control" onClick={() => moveFavorite(screen.id, 1)} disabled={!prefReady || index === favorites.length - 1} aria-label={`${screen.label} 아래로 이동`} title={`${screen.label} 아래로 이동`}><span aria-hidden="true">↓</span></button>
              <button type="button" className="nav-pref-control" onClick={() => toggleFavorite(screen.id)} disabled={!prefReady} aria-label={`${screen.label} 즐겨찾기에서 제거`} title={`${screen.label} 즐겨찾기에서 제거`}><span aria-hidden="true">×</span></button>
            </div>)}
          </section>}
          <div className="nav-personalization" data-testid="nav-personalization" data-pref-status={prefStatus}>
            <p>{NAV_PREF_NOTICE}</p>
            {prefError && <p role="alert" data-testid="nav-pref-error">{prefError}</p>}
          </div>
          {grouped.map(([, items]) => {
            const section = items[0]?.section;
            if (!section) return null;
            const storedCollapsed = pref.collapsedSectionIds.includes(section);
            const expanded = section === 'home' || section === activeSection || !storedCollapsed;
            return <div className={`nav-group ${section === 'home' ? 'nav-group--home' : ''}`} data-section={section} data-stored-collapsed={String(storedCollapsed)} key={section}>
              {section !== 'home' && <button type="button" className="nav-section-toggle nav-pref-control" aria-expanded={expanded} aria-controls={`nav-section-${section}`} disabled={!prefReady} onClick={() => toggleSection(section)} aria-label={`${sectionLabels[section]} 메뉴 ${expanded ? '접기' : '펼치기'}`}>
                <span>{sectionLabels[section]}</span><span aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>}
              <div className="nav-items" id={`nav-section-${section}`} hidden={!expanded}>
                {items.map(screen => <div className="nav-entry" key={screen.id}>
                  <NavLink to={screen.path} end={screen.path !== activePath} data-screen-id={screen.id} onClick={() => setSidebarOpen(false)} className={({ isActive }) => isActive ? "active" : ""}>
                    <span className="nav-mark" aria-hidden="true">{screen.label.slice(0, 1)}</span><span className="nav-label">{screen.label}</span>{screen.ai && <span className="nav-ai">AI</span>}
                  </NavLink>
                  <button type="button" className="nav-pref-control nav-pin" aria-pressed={pref.favoriteScreenIds.includes(screen.id)} disabled={!prefReady} onClick={() => toggleFavorite(screen.id)} aria-label={`${screen.label} 즐겨찾기${pref.favoriteScreenIds.includes(screen.id) ? '에서 제거' : '에 추가'}`} title={`${screen.label} 즐겨찾기${pref.favoriteScreenIds.includes(screen.id) ? '에서 제거' : '에 추가'}`}><span aria-hidden="true">…</span></button>
                </div>)}
              </div>
            </div>;
          })}
        </nav>
        <div className="sidebar__footer"><div className="user-block"><span className="avatar">{session.name.slice(0, 1)}</span><span><strong>{session.name}</strong><small>{session.email}</small></span></div><Button tone="neutral" size="small" onClick={logout}>로그아웃</Button><Button className="sidebar__close" tone="neutral" size="small" onClick={() => setSidebarOpen(false)}>메뉴 닫기</Button></div>
      </div>

      <div className="app-main">
        <header className="topbar">
          <Button className="menu-button" tone="neutral" size="small" onClick={event => { sidebarOpener.current = event.currentTarget; setSidebarOpen(true); }} aria-label="메뉴 열기" aria-expanded={modalSidebar} aria-controls="app-sidebar" aria-haspopup="dialog">메뉴</Button>
          <form className="global-search" onSubmit={(event) => { event.preventDefault(); const term = search.trim(); if (!term) return; const target = term.includes("@") ? "/members" : /문서|자료|규정|계약/.test(term) ? "/documents" : "/projects"; navigate(`${target}?q=${encodeURIComponent(term)}`); }}>
            <label><span className="sr-only">전역 검색</span><input type="search" placeholder="업무, 문서, 구성원 검색 후 Enter" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          </form>
          <div className="topbar__actions">{canOpen('/notifications') && <NavLink className="icon-link" to="/notifications" aria-label="알림">알림</NavLink>}{canOpen('/agent') && <Button tone="ai" size="small" onClick={toggleAgent}>AI Agent</Button>}</div>
        </header>
        <main id="main-content" tabIndex={-1} key={`${session.orgId}:${location.pathname}`}>
          {access.error ? <section className="state-card" role="alert"><h1>접근 권한을 확인하지 못했습니다</h1><p>{access.error}</p><Button onClick={access.retry}>다시 시도</Button></section>
            : !access.data ? <p role="status">접근 권한을 확인하는 중입니다…</p>
              : !allowed ? <section className="state-card" role="alert" data-testid="screen-access-denied"><h1>접근할 수 없습니다</h1><p>이 메뉴의 역할 권한이 없거나 조직에서 기능이 꺼져 있습니다.</p></section> : <Outlet />}
        </main>
      </div>
      {canOpen('/agent') && <AgentPanel />}
      <nav className="mobile-nav" aria-label="모바일 주 메뉴">{mobilePaths.map(path => visibleNavigation.find(item => item.path === path)).filter(screen => screen !== undefined).map(screen => <NavLink key={screen.path} to={screen.path} end={screen.path === "/"}>{screen.label}</NavLink>)}</nav>
    </div>
    </AccessContext.Provider>
  );
}
