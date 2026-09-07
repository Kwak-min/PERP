import { useState } from "react";
import { matchPath, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAppContext } from "../../context/AppContext";
import { navigation, screens, sectionLabels } from "../../routes/catalog";
import { AccessContext, canOpenScreen, useWorkspaceAccess } from '../../hooks/useWorkspaceAccess';
import { logout as revokeSession } from "../../services/auth";
import { sessionStore, useSession } from "../../store/session";
import { Button } from "../ui/Button";
import { AgentPanel } from "./AgentPanel";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const mobilePaths = ['/', '/tasks', '/calendar', '/settings'];

export function AppShell() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarOpen, setSidebarOpen, toggleAgent, toggleSidebar } = useAppContext();
  const [search, setSearch] = useState("");
  const access = useWorkspaceAccess(session, location.pathname);
  if (!session) return null;
  const activeSession = session;
  const visibleNavigation = navigation.filter(screen => access.data && canOpenScreen(access.data, screen));
  const currentScreen = screens.filter(screen => matchPath({ path: screen.path, end: true }, location.pathname))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const allowed = Boolean(access.data && currentScreen && canOpenScreen(access.data, currentScreen));
  const canOpen = (path: string) => Boolean(access.data && screens.some(screen => screen.path === path && canOpenScreen(access.data!, screen)));
  // 별도 메뉴가 있는 하위 경로만 부모 강조를 해제한다. 실제 상세 화면은 부모를 유지한다.
  const activePath = navigation.reduce((active, screen) =>
    matchPath({ path: screen.path, end: screen.path === "/" }, location.pathname)
      && screen.path.length > active.length ? screen.path : active, "");

  const grouped = Object.entries(
    visibleNavigation.reduce<Record<string, typeof navigation>>((groups, screen) => {
      const current = groups[screen.section] ?? [];
      return { ...groups, [screen.section]: [...current, screen] };
    }, {}),
  );

  async function logout(): Promise<void> {
    try {
      await revokeSession(activeSession.token, activeSession.orgId);
    } finally {
      sessionStore.clear();
      navigate("/login");
    }
  }

  return (
    <AccessContext.Provider value={access.data}>
    <div className="app-frame">
      <button
        className={`sidebar-scrim ${sidebarOpen ? "sidebar-scrim--open" : ""}`}
        aria-label="메뉴 닫기"
        onClick={() => setSidebarOpen(false)}
      />
      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__brand"><WorkspaceSwitcher session={activeSession} /></div>
        <nav aria-label="주 메뉴">
          {grouped.map(([section, items]) => (
            <div className="nav-group" key={section}>
              {section !== 'home' && section !== 'admin' && <p>{sectionLabels[section as keyof typeof sectionLabels]}</p>}
              {items?.map((screen) => (
                <NavLink
                  key={screen.path}
                  to={screen.path}
                  end={screen.path !== activePath}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) => (isActive ? "active" : "")}
                >
                  <span className="nav-mark" aria-hidden="true">{screen.label.slice(0, 1)}</span>
                  {screen.label}
                  {screen.ai && <span className="nav-ai">AI</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="user-block">
            <span className="avatar">{session.name.slice(0, 1)}</span>
            <span><strong>{session.name}</strong><small>{session.email}</small></span>
          </div>
          <Button tone="neutral" size="small" onClick={logout}>로그아웃</Button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <Button className="menu-button" tone="neutral" size="small" onClick={toggleSidebar} aria-label="메뉴 열기">메뉴</Button>
          <form
            className="global-search"
            onSubmit={(event) => {
              event.preventDefault();
              const term = search.trim();
              if (!term) return;
              const target = term.includes("@")
                ? "/members"
                : /문서|자료|규정|계약/.test(term)
                  ? "/documents"
                  : "/tasks";
              navigate(`${target}?q=${encodeURIComponent(term)}`);
            }}
          >
            <label>
              <span className="sr-only">전역 검색</span>
              <input
                type="search"
                placeholder="업무, 문서, 구성원 검색 후 Enter"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </form>
          <div className="topbar__actions">
            {canOpen('/notifications') && <NavLink className="icon-link" to="/notifications" aria-label="알림">알림</NavLink>}
            {canOpen('/agent') && <Button tone="ai" size="small" onClick={toggleAgent}>AI Agent</Button>}
          </div>
        </header>
        <main id="main-content" key={`${session.orgId}:${location.pathname}`}>
          {access.error ? <section className="state-card" role="alert"><h1>접근 권한을 확인하지 못했습니다</h1><p>{access.error}</p><Button onClick={access.retry}>다시 시도</Button></section>
            : !access.data ? <p role="status">접근 권한을 확인하는 중입니다…</p>
              : !allowed ? <section className="state-card" role="alert" data-testid="screen-access-denied"><h1>접근할 수 없습니다</h1><p>이 메뉴의 역할 권한이 없거나 조직에서 기능이 꺼져 있습니다.</p></section>
                : <Outlet />}
        </main>
      </div>
      {canOpen('/agent') && <AgentPanel />}

      <nav className="mobile-nav" aria-label="모바일 주 메뉴">
        {mobilePaths.filter(canOpen).map((path) => {
          const screen = navigation.find((item) => item.path === path);
          return (
            <NavLink key={path} to={path} end={path === "/"}>
              {screen?.label ?? (path === "/notifications" ? "알림" : "Agent")}
            </NavLink>
          );
        })}
      </nav>
    </div>
    </AccessContext.Provider>
  );
}
