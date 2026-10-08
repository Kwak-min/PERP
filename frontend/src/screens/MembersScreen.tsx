import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { Av, Empty, PageHead, Pill, Tabs, maskPhone } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Member = {
  membership_id: string;
  user_id: string;
  email: string;
  name: string;
  roles: string[];
  status: string;
  department_id: string | null;
  title: string | null;
  phone: string | null;
};
type RoleDef = { key: string; label: string; scope: string };
type Dept = { id: string; name: string };

const STATUS_TONE: Record<string, string> = { active: "ok", inactive: "muted", left: "muted" };
const STATUS_LABEL: Record<string, string> = {
  active: "활성",
  inactive: "비활성",
  left: "탈퇴",
};

// ORG-002 회원 — 실제 백엔드(/members) 연동, 목업 디자인 유지
export function MembersScreen() {
  const [tab, setTab] = useState("list");
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [st, setSt] = useState("active");
  const pii = false; // 연락처는 개인 등급 → 권한 없으면 마스킹

  const membersRes = useApi<{ items: Member[] }>("/members");
  const rolesRes = useApi<{ items: RoleDef[] }>("/members/roles");
  const deptsRes = useApi<{ items: Dept[] }>("/members/departments");

  const members = membersRes.data?.items ?? [];
  const roleLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rolesRes.data?.items ?? []) map.set(r.key, r.label);
    return (keys: string[]) => keys.map((k) => map.get(k) ?? k).join(", ");
  }, [rolesRes.data]);
  const deptName = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of deptsRes.data?.items ?? []) map.set(d.id, d.name);
    return (id: string | null) => (id ? (map.get(id) ?? "-") : "-");
  }, [deptsRes.data]);

  const rows = members.filter(
    (m) =>
      (!st || m.status === st) &&
      (!role || m.roles.includes(role)) &&
      (!q || `${m.name} ${m.email}`.includes(q)),
  );
  const activeCount = members.filter((m) => m.status === "active").length;

  return (
    <>
      <PageHead
        title="회원"
        id="ORG-002"
        fr="SFR-003"
        desc={`연락처는 개인 등급이라 ${
          pii
            ? "전체 표시 중입니다 (개인정보 열람 권한)."
            : "마스킹됩니다. 내보내기·로그·AI 답변에서도 같은 규칙이 적용됩니다."
        }`}
        actions={
          <>
            <button type="button" className="btn">
              <Icon name="download" />
              CSV
            </button>
            <button type="button" className="btn btn-primary">
              <Icon name="plus" />
              초대
            </button>
          </>
        }
      />
      <Tabs
        items={[
          ["list", "회원", activeCount],
          ["invites", "초대"],
        ]}
        cur={tab}
        onChange={setTab}
      />

      {tab === "invites" ? (
        <div className="panel">
          <Empty
            title="대기 중인 초대가 없습니다"
            desc="상단 '초대' 버튼으로 이메일을 초대하면 여기에 표시됩니다."
          />
        </div>
      ) : (
        <>
          <div className="filters">
            <input
              type="search"
              placeholder="이름·이메일"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="검색"
            />
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="역할">
              <option value="">모든 역할</option>
              {(rolesRes.data?.items ?? []).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태">
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
              <option value="left">탈퇴</option>
              <option value="">전체</option>
            </select>
          </div>
          <div className="panel tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>이메일</th>
                  <th>연락처</th>
                  <th>역할</th>
                  <th>부서</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {membersRes.loading ? (
                  <tr>
                    <td colSpan={6}>
                      <Empty title="불러오는 중…" icon="clock" />
                    </td>
                  </tr>
                ) : membersRes.error ? (
                  <tr>
                    <td colSpan={6}>
                      <Empty title="회원을 불러오지 못했습니다" desc={membersRes.error} icon="alert" />
                    </td>
                  </tr>
                ) : rows.length ? (
                  rows.map((m) => (
                    <tr key={m.membership_id}>
                      <td className="nowrap">
                        <Av name={m.name} size="sm" />{" "}
                        <Link className="t-title" to={`/members/${m.user_id}`}>
                          {m.name}
                        </Link>
                        {m.title && <span className="sub">{m.title}</span>}
                      </td>
                      <td className="muted">{m.email}</td>
                      <td className="mono xs nowrap">
                        {m.phone ? (pii ? m.phone : maskPhone(m.phone)) : "-"}
                      </td>
                      <td>{roleLabel(m.roles)}</td>
                      <td>{deptName(m.department_id)}</td>
                      <td>
                        <Pill tone={STATUS_TONE[m.status] ?? "muted"}>
                          {STATUS_LABEL[m.status] ?? m.status}
                        </Pill>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>
                      <Empty title="조건에 맞는 회원이 없습니다" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
