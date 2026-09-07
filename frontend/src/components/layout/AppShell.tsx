import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAppContext } from "../../context/AppContext";
import { navigation, sectionLabels } from "../../routes/catalog";
import { logout as revokeSession } from "../../services/auth";
import { sessionStore, useSession } from "../../store/session";
import { Button } from "../ui/Button";
import { AgentPanel } from "./AgentPanel";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const mobilePaths = ["/", "/tasks", "/calendar", "/notifications", "/agent"];

export function AppShell() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarOpen, setSidebarOpen, toggleAgent, toggleSidebar } = useAppContext();
  const [search, setSearch] = useState("");
  if (!session) return null;
  const activeSession = session;
  const grouped = Object.entries(
    navigation.reduce<Record<string, typeof navigation>>((groups, screen) => {
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
              <p>{sectionLabels[section as keyof typeof sectionLabels]}</p>
              {items?.map((screen) => (
                <NavLink
                  key={screen.path}
                  to={screen.path}
                  end={screen.path === "/"}
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
            <NavLink className="icon-link" to="/notifications" aria-label="알림">알림</NavLink>
            <Button tone="ai" size="small" onClick={toggleAgent}>AI Agent</Button>
          </div>
        </header>
        <main id="main-content" key={location.pathname}><Outlet /></main>
      </div>
      <AgentPanel />

      <nav className="mobile-nav" aria-label="모바일 주 메뉴">
        {mobilePaths.map((path) => {
          const screen = navigation.find((item) => item.path === path);
          return (
            <NavLink key={path} to={path} end={path === "/"}>
              {screen?.label ?? (path === "/notifications" ? "알림" : "Agent")}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
