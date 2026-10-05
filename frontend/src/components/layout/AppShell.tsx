import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAppContext } from "../../context/AppContext";
import { apiRequest } from "../../services/api";
import { sessionStore, useSession } from "../../store/session";
import { Icon } from "../ui/Icon";
import { AgentPanel } from "./AgentPanel";
import { NAV, ORG_TYPES, bestNavPath } from "./shellNav";

const TABBAR: Array<[string, string, string]> = [
  ["/", "홈", "home"],
  ["/tasks", "업무", "tasks"],
  ["/calendar", "캘린더", "calendar"],
  ["/notifications", "알림", "bell"],
  ["/agent", "Agent", "sparkles"],
];

type ThemePref = "system" | "light" | "dark";

function readTheme(): ThemePref {
  try {
    return (localStorage.getItem("of-theme") as ThemePref) || "system";
  } catch {
    return "system";
  }
}

function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
}

function LogoMark() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" style={{ fill: "var(--of-primary)" }} />
      <ellipse
        cx="16"
        cy="16"
        rx="11"
        ry="5.2"
        fill="none"
        stroke="#fff"
        strokeOpacity=".55"
        strokeWidth="1.6"
        transform="rotate(-28 16 16)"
      />
      <circle cx="16" cy="16" r="4.2" fill="#fff" />
      <circle cx="25.2" cy="11.2" r="2.2" fill="#C4B5FD" />
    </svg>
  );
}

export function AppShell() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { agentOpen, sidebarOpen, setSidebarOpen, toggleAgent, toggleSidebar } =
    useAppContext();
  const [menu, setMenu] = useState<"org" | "create" | "profile" | null>(null);
  const [theme, setTheme] = useState<ThemePref>(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 경로 이동 시 열린 메뉴/사이드바 닫기
  useEffect(() => {
    setMenu(null);
    setSidebarOpen(false);
  }, [location.pathname, setSidebarOpen]);

  if (!session) return null;
  const activeSession = session;

  const org =
    activeSession.organizations.find((o) => o.org_id === activeSession.orgId) ??
    activeSession.organizations[0];
  const orgName = org?.org_name ?? "조직";
  const orgTypeLabel = org?.org_type ? ORG_TYPES[org.org_type] ?? "" : "";
  const roleLabel = org?.roles?.[0] ?? "";
  const best = bestNavPath(location.pathname);

  function cycleTheme(): void {
    const order: ThemePref[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length] ?? "system";
    try {
      localStorage.setItem("of-theme", next);
    } catch {
      /* 저장 불가 무시 */
    }
    setTheme(next);
  }

  const themeIc: Record<ThemePref, string> = {
    system: "monitor",
    light: "sun",
    dark: "moon",
  };

  async function logout(): Promise<void> {
    try {
      await apiRequest("/auth/logout", {
        method: "POST",
        session: { token: activeSession.token, orgId: activeSession.orgId },
      });
    } finally {
      sessionStore.clear();
      navigate("/login");
    }
  }

  return (
    <div
      className={`shell${agentOpen ? " agent-open" : ""}${sidebarOpen ? " nav-open" : ""}`}
    >
      <aside className="sidebar" aria-label="주 메뉴">
        <NavLink className="brand" to="/">
          <LogoMark />
          <span className="brand-t">
            <b>PERP</b>
            <small>소규모 조직 운영 OS</small>
          </span>
        </NavLink>
        <nav className="nav">
          {NAV.map((group, gi) => (
            <div className="nav-g" key={group.group ?? `g${gi}`}>
              {group.group && <div className="nav-gl">{group.group}</div>}
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  title={item.label}
                  className={item.path === best ? "nav-i on" : "nav-i"}
                  aria-current={item.path === best ? "page" : undefined}
                >
                  <Icon name={item.icon} />
                  <span className="nav-t">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <span className="av" title={activeSession.name}>
            {activeSession.name.slice(-2)}
          </span>
          <div className="sf-t">
            <b>{activeSession.name}</b>
            <small>{roleLabel}</small>
          </div>
          <button
            type="button"
            className="icon-btn sm"
            onClick={logout}
            title="로그아웃"
            aria-label="로그아웃"
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <button
        type="button"
        className="nav-scrim"
        aria-label="메뉴 닫기"
        onClick={() => setSidebarOpen(false)}
      />

      <header className="topbar">
        <button
          type="button"
          className="icon-btn only-narrow"
          onClick={toggleSidebar}
          aria-label="메뉴 열기"
        >
          <Icon name="menu" />
        </button>

        <div className="menu-root">
          <button
            type="button"
            className="org-btn"
            onClick={() => setMenu(menu === "org" ? null : "org")}
            aria-haspopup="menu"
            aria-expanded={menu === "org"}
          >
            <span className="org-mark">{orgName.slice(0, 1)}</span>
            <span className="org-name">{orgName}</span>
            {orgTypeLabel && <span className="pill info hide-sm">{orgTypeLabel}</span>}
            <Icon name="down" />
          </button>
          {menu === "org" && (
            <div className="pop" role="menu">
              <div className="pop-l">조직 전환 · 데이터는 조직별로 격리됩니다</div>
              {activeSession.organizations.map((o) => (
                <button
                  type="button"
                  role="menuitem"
                  key={o.org_id}
                  className={o.org_id === org?.org_id ? "pop-i on" : "pop-i"}
                  onClick={() => {
                    sessionStore.patch({ orgId: o.org_id });
                    setMenu(null);
                  }}
                >
                  <span className="org-mark sm">{o.org_name.slice(0, 1)}</span>
                  <span className="pop-t">
                    <b>{o.org_name}</b>
                    <small>
                      {o.org_type ? ORG_TYPES[o.org_type] ?? "" : ""}
                      {o.roles?.[0] ? ` · ${o.roles[0]}` : ""}
                    </small>
                  </span>
                  {o.org_id === org?.org_id && <Icon name="check" />}
                </button>
              ))}
              <div className="pop-sep" />
              <NavLink role="menuitem" className="pop-i" to="/onboarding/organization">
                <Icon name="plus" />
                <span className="pop-t">
                  <b>새 조직 만들기</b>
                  <small>유형별 템플릿으로 시작</small>
                </span>
              </NavLink>
            </div>
          )}
        </div>

        <button
          type="button"
          className="search-btn"
          onClick={() => navigate("/tasks")}
          aria-label="검색 또는 이동"
        >
          <Icon name="search" />
          <span>검색하거나 화면으로 이동</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="tb-right">
          <NavLink className="icon-btn has-dot" to="/notifications" aria-label="알림">
            <Icon name="bell" />
          </NavLink>
          <button
            type="button"
            className="icon-btn hide-sm"
            onClick={cycleTheme}
            aria-label={`테마 전환 (현재: ${theme})`}
            title={`테마: ${{ system: "시스템", light: "라이트", dark: "다크" }[theme]}`}
          >
            <Icon name={themeIc[theme]} />
          </button>
          <button
            type="button"
            className={`btn btn-ai btn-sm${agentOpen ? " on" : ""}`}
            onClick={toggleAgent}
            aria-pressed={agentOpen}
          >
            <Icon name="sparkles" />
            <span className="hide-sm">Agent</span>
          </button>
          <div className="menu-root">
            <button
              type="button"
              className="av-btn"
              onClick={() => setMenu(menu === "profile" ? null : "profile")}
              aria-haspopup="menu"
              aria-expanded={menu === "profile"}
              aria-label="내 계정"
            >
              <span className="av" title={activeSession.name}>
                {activeSession.name.slice(-2)}
              </span>
            </button>
            {menu === "profile" && (
              <div className="pop right wide" role="menu">
                <div className="pop-head">
                  <span className="av" title={activeSession.name}>
                    {activeSession.name.slice(-2)}
                  </span>
                  <div>
                    <b>{activeSession.name}</b>
                    <small>
                      {activeSession.email}
                      {roleLabel ? ` · ${roleLabel}` : ""}
                    </small>
                  </div>
                </div>
                <div className="pop-sep" />
                <button type="button" role="menuitem" className="pop-i" onClick={cycleTheme}>
                  <Icon name="moon" />
                  <span className="pop-t">
                    <b>테마 전환</b>
                  </span>
                </button>
                <button type="button" role="menuitem" className="pop-i" onClick={logout}>
                  <Icon name="logout" />
                  <span className="pop-t">
                    <b>로그아웃</b>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        <div className="page" key={location.pathname}>
          <Outlet />
        </div>
      </main>

      {agentOpen && <AgentPanel />}

      <nav className="tabbar" aria-label="하단 탭">
        {TABBAR.map(([path, label, icon]) => (
          <NavLink
            key={path}
            to={path}
            end={path === "/"}
            className={({ isActive }) => (isActive ? "on" : "")}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
