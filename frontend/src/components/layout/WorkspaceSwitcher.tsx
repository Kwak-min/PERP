import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useDepartmentResource } from "../../hooks/useDepartments";
import { useRoles } from "../../hooks/useRoles";
import { apiRequest, userMessageOf } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { branchStore, useBranch } from "../../store/branch";
import { sessionStore, type SessionState } from "../../store/session";

import "./workspace-picker.css";

/**
 * 사이드바 최상단의 회사 선택기.
 * 1단: 내가 속한 회사(워크스페이스), 2단: 그 회사 안의 부서 브랜치.
 * 브랜치는 여기서 바로 만들 수 있고, 접근 그룹으로 들어갈 수 있는 사람을 정한다.
 */
export function WorkspaceSwitcher({ session }: Readonly<{ session: SessionState }>) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [accessRoles, setAccessRoles] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const pg = isPgWorkspace(session.orgId);
  const apiSession = session.orgId ? { token: session.token, orgId: session.orgId } : null;
  const { departments, status: departmentStatus, error: departmentError } = useDepartmentResource(apiSession, reloadKey);
  const departmentsReady = departmentStatus === "ready" || departmentStatus === "empty";
  const roles = useRoles(apiSession);
  const branchId = useBranch(session.orgId);

  const activeOrg = session.organizations.find((org) => org.org_id === session.orgId);
  const activeBranch = departments.find((department) => department.id === branchId);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // 브랜치로 지정한 부서가 사라지거나 접근 권한을 잃으면 전사 범위로 되돌린다.
  useEffect(() => {
    if (!session.orgId || !branchId || !departmentsReady) return;
    const found = departments.find((department) => department.id === branchId);
    if (!found || !found.can_enter) branchStore.select(session.orgId, null);
  }, [branchId, departments, departmentsReady, session.orgId]);

  function toggleRole(role: string): void {
    setAccessRoles((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    );
  }

  async function createBranch(): Promise<void> {
    if (!apiSession || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/pg/members/departments", {
        method: "POST",
        session: apiSession,
        body: {
          name: name.trim(),
          ...(branchId ? { parent_id: branchId } : {}),
          ...(!pg ? { access_roles: accessRoles } : {}),
        },
      });
      setName("");
      setAccessRoles([]);
      setCreating(false);
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-picker" ref={wrapRef}>
      <button
        type="button"
        className="workspace-picker__button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="workspace-picker__mark" aria-hidden="true">
          {(activeOrg?.org_name ?? "?").slice(0, 1)}
        </span>
        <span className="workspace-picker__text">
          <strong>{activeOrg?.org_name ?? "조직 선택"}</strong>
          <small>{activeBranch ? `${activeBranch.name} 브랜치` : branchId ? "브랜치 확인 필요" : "전사 범위"}</small>
        </span>
        <span className="workspace-picker__caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="workspace-picker__menu" role="menu">
          <p className="workspace-picker__group">회사</p>
          {session.organizations.map((org) => (
            <button
              key={org.org_id}
              type="button"
              role="menuitemradio"
              aria-checked={org.org_id === session.orgId}
              className={
                org.org_id === session.orgId
                  ? "workspace-picker__item workspace-picker__item--on"
                  : "workspace-picker__item"
              }
              onClick={() => {
                sessionStore.patch({ orgId: org.org_id });
                setOpen(false);
              }}
            >
              <b>{org.org_name}</b>
              <span>{org.roles.join(", ") || "구성원"}</span>
            </button>
          ))}
          {session.organizations.length === 0 && (
            <p className="workspace-picker__empty">소속 회사가 없습니다</p>
          )}
          <button
            type="button"
            role="menuitem"
            className="workspace-picker__item workspace-picker__add"
            onClick={() => {
              setOpen(false);
              navigate("/onboarding/organization");
            }}
          >
            <b>조직 추가</b>
          </button>

          {session.orgId && (
            <>
              <div className="workspace-picker__group-row">
                <p className="workspace-picker__group">부서 브랜치</p>
                <div className="workspace-picker__group-actions">
                  <button
                    type="button"
                    className="workspace-picker__icon"
                    aria-label="브랜치 만들기"
                    title="브랜치 만들기"
                    disabled={!departmentsReady}
                    onClick={() => setCreating((value) => !value)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="workspace-picker__icon workspace-picker__icon--text"
                    onClick={() => {
                      setOpen(false);
                      navigate("/settings/branches");
                    }}
                  >
                    설정
                  </button>
                </div>
              </div>

              {creating && (
                <div className="branch-create">
                  <label>
                    브랜치 이름
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={branchId ? `${activeBranch?.name} 하위 브랜치` : "예: 개발팀"}
                      autoFocus
                    />
                  </label>
                  {pg ? <p>PG 브랜치는 브랜치별 접근 그룹 설정을 지원하지 않습니다.</p> : <fieldset className="branch-create__roles">
                    <legend>들어갈 수 있는 그룹</legend>
                    {roles.map((role) => (
                      <label key={role.key}>
                        <input
                          type="checkbox"
                          checked={accessRoles.includes(role.key)}
                          onChange={() => toggleRole(role.key)}
                        />
                        <span>{role.label}</span>
                      </label>
                    ))}
                    <p>선택하지 않으면 조직 전체가 들어갈 수 있습니다.</p>
                  </fieldset>}
                  {error && <p className="branch-create__error">{error}</p>}
                  <div className="branch-create__actions">
                    <button type="button" onClick={() => setCreating(false)}>취소</button>
                    <button
                      type="button"
                      className="branch-create__submit"
                      disabled={busy || !name.trim()}
                      onClick={() => void createBranch()}
                    >
                      {busy ? "만드는 중…" : "브랜치 만들기"}
                    </button>
                  </div>
                </div>
              )}

              <button
                type="button"
                role="menuitemradio"
                aria-checked={branchId === null}
                className={
                  branchId === null
                    ? "workspace-picker__item workspace-picker__item--on"
                    : "workspace-picker__item"
                }
                onClick={() => {
                  branchStore.select(session.orgId as string, null);
                  setOpen(false);
                }}
              >
                <b>전사 범위</b>
                <span>모든 부서를 함께 봅니다</span>
              </button>
              {departments.map((department) => (
                <button
                  key={department.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={department.id === branchId}
                  disabled={!department.can_enter}
                  className={
                    department.id === branchId
                      ? "workspace-picker__item workspace-picker__item--on"
                      : "workspace-picker__item"
                  }
                  onClick={() => {
                    branchStore.select(session.orgId as string, department.id);
                    setOpen(false);
                  }}
                >
                  <b>{department.name}</b>
                  <span>
                    {pg ? "브랜치별 접근 그룹 미지원" : department.access_roles.length === 0
                      ? "조직 전체 공개"
                      : `${department.access_roles.length}개 그룹만 접근`}
                  </span>
                </button>
              ))}
              {departmentStatus === "loading" && (
                <p className="workspace-picker__empty" role="status">부서를 확인하고 있습니다.</p>
              )}
              {(departmentStatus === "error" || departmentStatus === "forbidden") && (
                <div className="workspace-picker__empty">
                  <p role="alert">{userMessageOf(departmentError)}</p>
                  <button type="button" onClick={() => setReloadKey((value) => value + 1)}>부서 다시 확인</button>
                </div>
              )}
              {departmentStatus === "empty" && (
                <p className="workspace-picker__empty">브랜치가 없습니다. +로 만들어 보세요.</p>
              )}
              <p className="workspace-picker__note">
                휴가·근태·회계는 브랜치와 무관하게 전사 기준으로 처리됩니다.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
