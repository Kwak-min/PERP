import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import {
  MEM_LABEL,
  MEM_TONE,
  demoInvites,
  demoMemberRows,
  demoRoles,
} from "./mockup/demo";
import { Av, Empty, PageHead, Pill, Tabs, maskPhone } from "./mockup/lib";

// ORG-002 회원 — 목업 membersView() 이식
export function MembersScreen() {
  const [tab, setTab] = useState("list");
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [st, setSt] = useState("active");
  const pii = false; // 개인정보 열람 권한 없음 → 마스킹 (목업 기본)

  const rows = demoMemberRows.filter(
    (m) =>
      (!st || m.status === st) &&
      (!role || m.role === role) &&
      (!q || `${m.name} ${m.email}`.includes(q)),
  );
  const activeCount = demoMemberRows.filter((m) => m.status === "active").length;

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
          ["invites", "초대", demoInvites.length],
        ]}
        cur={tab}
        onChange={setTab}
      />

      {tab === "invites" ? (
        <div className="panel tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>이메일</th>
                <th>역할</th>
                <th>초대한 사람</th>
                <th>만료</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {demoInvites.map((i) => (
                <tr key={i.email}>
                  <td className="t-title">{i.email}</td>
                  <td>{i.role}</td>
                  <td>{i.invitedBy}</td>
                  <td className="nowrap">{i.expiresAt}</td>
                  <td>{i.expired ? <Pill tone="bad">만료</Pill> : <Pill tone="warn">대기</Pill>}</td>
                  <td className="nowrap">
                    <button type="button" className="btn btn-xs">
                      재발송
                    </button>{" "}
                    <button type="button" className="btn btn-xs btn-ghost">
                      회수
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              {demoRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태">
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
              <option value="withdrawn">탈퇴</option>
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
                  <th>가입</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((m) => (
                    <tr key={m.email}>
                      <td className="nowrap">
                        <Av name={m.name} size="sm" />{" "}
                        <Link className="t-title" to={`/members/${m.name}`}>
                          {m.name}
                        </Link>
                        <span className="sub">{m.title}</span>
                      </td>
                      <td className="muted">{m.email}</td>
                      <td className="mono xs nowrap">{pii ? m.phone : maskPhone(m.phone)}</td>
                      <td>{m.role}</td>
                      <td>{m.dept}</td>
                      <td>
                        <Pill tone={MEM_TONE[m.status]}>{MEM_LABEL[m.status]}</Pill>
                      </td>
                      <td className="muted nowrap">{m.joinedAt}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7}>
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
