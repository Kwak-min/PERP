import { useEffect, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { StateBoundary } from "../components/common/StateBoundary";
import { useDepartmentResource, type Department } from "../hooks/useDepartments";
import { useRoles } from "../hooks/useRoles";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";

import "./branches.css";

export function BranchSettingsScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [accessRoles, setAccessRoles] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apiSession = session?.orgId ? { token: session.token, orgId: session.orgId } : null;
  const departmentResource = useDepartmentResource(apiSession, reloadKey);
  const { departments } = departmentResource;
  const roles = useRoles(apiSession);
  const selected = departments.find((department) => department.id === selectedId) ?? null;

  // 선택한 브랜치가 바뀌면 편집 필드를 그 값으로 맞춘다.
  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setParentId(selected.parent_id ?? "");
    setAccessRoles(selected.access_roles);
  }, [selected?.id, selected?.name, selected?.parent_id, selected?.access_roles.join(",")]);

  function toggleRole(role: string): void {
    setAccessRoles((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    );
  }

  async function save(): Promise<void> {
    if (!apiSession || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/pg/members/departments/${selected.id}`, {
        method: "PATCH",
        session: apiSession,
        body: { name: name.trim(), parent_id: parentId || null },
      });
      await apiRequest(`/pg/members/departments/${selected.id}/access`, {
        method: "PUT",
        session: apiSession,
        body: { access_roles: accessRoles },
      });
      setNotice(`${name.trim()} 브랜치 설정을 저장했습니다.`);
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function accessLabel(department: Department): string {
    if (department.access_roles.length === 0) return "조직 전체 공개";
    return department.access_roles
      .map((role) => roles.find((item) => item.key === role)?.label ?? role)
      .join(", ");
  }

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">관리</span>
            <Badge>{screen.id}</Badge>
          </div>
          <h1>{screen.label}</h1>
          <p>{screen.description}</p>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      <div className="branch-layout">
        <SectionCard padded title="브랜치" subtitle="부서 단위 작업 공간" foot="사이드바 회사 선택기의 + 로도 만들 수 있습니다">
          <StateBoundary
            status={departmentResource.status}
            error={departmentResource.error}
            emptyTitle="브랜치가 없습니다"
            emptyDescription="사이드바 회사 선택기의 + 로 만드세요."
          >
            <ul className="branch-list">
              {departments.map((department) => (
                <li key={department.id}>
                  <button
                    type="button"
                    className={
                      department.id === selectedId ? "branch-list__item branch-list__item--on" : "branch-list__item"
                    }
                    onClick={() => setSelectedId(department.id)}
                  >
                    <b>{department.name}</b>
                    <span>{accessLabel(department)}</span>
                    {department.parent_id && (
                      <small>
                        상위 · {departments.find((d) => d.id === department.parent_id)?.name ?? "—"}
                      </small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </StateBoundary>
        </SectionCard>

        <SectionCard padded title="브랜치 설정" subtitle="이름, 상위 브랜치와 접근 그룹">
          {!selected ? (
            <p className="branch-empty">왼쪽에서 브랜치를 선택하세요.</p>
          ) : (
            <div className="branch-form">
              <label>
                브랜치 이름
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                상위 브랜치
                <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                  <option value="">— 최상위 —</option>
                  {departments
                    .filter((department) => department.id !== selected.id)
                    .map((department) => (
                      <option key={department.id} value={department.id}>{department.name}</option>
                    ))}
                </select>
              </label>
              <fieldset className="branch-form__roles">
                <legend>들어갈 수 있는 그룹</legend>
                {roles.map((role) => (
                  <label key={role.key}>
                    <input
                      type="checkbox"
                      checked={accessRoles.includes(role.key)}
                      onChange={() => toggleRole(role.key)}
                    />
                    <span>
                      <b>{role.label}</b>
                      <small>{role.key}</small>
                    </span>
                  </label>
                ))}
                <p>하나도 선택하지 않으면 조직 전체가 이 브랜치에 들어갈 수 있습니다.</p>
              </fieldset>
              <div className="branch-form__actions">
                <Button disabled={busy || name.trim() === ""} onClick={() => void save()}>
                  {busy ? "저장 중…" : "설정 저장"}
                </Button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
