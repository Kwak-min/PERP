import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import type { OrgMember, OrgSeat } from "./model";
import "../../components/data/member-pagination.css";

type Props = Readonly<{
  members: readonly OrgMember[];
  seats: readonly OrgSeat[];
  selectedMemberId: string | null;
  initialQuery: string;
  onSelect: (membershipId: string) => void;
}>;

export function MemberDirectory({ members, seats, selectedMemberId, initialQuery, onSelect }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  useEffect(() => { setQuery(initialQuery); setPage(1); }, [initialQuery]);
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState("");
  const departmentName = (member: OrgMember) => seats.find(seat => seat.id === member.department_id)?.name ?? member.department_id ?? "미배정";
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ko-KR");
    return members.filter(member => (!department || (department === "unassigned" ? !member.department_id : member.department_id === department))
      && (!status || member.status === status)
      && [member.name, member.email, member.title, member.status, seats.find(seat => seat.id === member.department_id)?.name, ...member.roles]
        .some(value => value?.toLocaleLowerCase("ko-KR").includes(needle)));
  }, [members, seats, query, department, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * 10;
  const visible = filtered.slice(offset, offset + 10);
  useEffect(() => { setPage(value => Math.min(value, pageCount)); }, [pageCount]);
  const statusLabels: Readonly<Record<string, string>> = { active: "활성", inactive: "휴면", left: "탈퇴" };
  const statusLabel = (value: string) => statusLabels[value] ?? value;
  function exportCsv(): void {
    const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [["이름", "이메일", "부서", "직책", "역할", "상태"], ...filtered.map(member => [member.name, member.email, departmentName(member), member.title ?? "", member.roles.join(" · "), statusLabel(member.status)])];
    const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "구성원.csv"; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="org-directory"><SectionCard title="구성원 목록" subtitle={`전체 ${members.length}명`} foot="이름을 선택하면 조직도와 같은 상세 패널에서 확인할 수 있습니다">
    <div className="org-directory__filters">
      <label>구성원 검색<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="이름, 이메일, 부서, 역할" /></label>
      <label>부서<select aria-label="부서" value={department} onChange={event => { setDepartment(event.target.value); setPage(1); }}><option value="">전체 부서</option><option value="unassigned">미배정</option>{seats.map(seat => <option key={seat.id} value={seat.id}>{seat.name}</option>)}</select></label>
      <label>상태<select aria-label="상태" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">전체 상태</option>{[...new Set(members.map(member => member.status))].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
      <Button tone="neutral" size="small" disabled={filtered.length === 0} onClick={exportCsv}>내보내기</Button>
    </div>
    <p className="org-directory__count" role="status">검색 결과 {filtered.length}명</p>
    {filtered.length === 0 ? <p className="orgchart__empty">{members.length === 0 ? "등록된 구성원이 없습니다." : "검색 조건에 맞는 구성원이 없습니다."}</p>
      : <div className="org-directory__table"><table><thead><tr><th scope="col">이름</th><th scope="col">이메일</th><th scope="col">부서</th><th scope="col">직책</th><th scope="col">역할</th><th scope="col">상태</th></tr></thead><tbody>{visible.map(member => <tr key={member.membership_id} data-selected={selectedMemberId === member.membership_id}>
        <td><button type="button" className="orgchart__name" aria-pressed={selectedMemberId === member.membership_id} onClick={() => onSelect(member.membership_id)}>{member.name}</button></td><td>{member.email}</td><td>{departmentName(member)}</td><td>{member.title ?? "미지정"}</td><td>{member.roles.join(" · ") || "미지정"}</td><td>{statusLabel(member.status)}</td>
      </tr>)}</tbody></table></div>}
    <nav className="member-pagination" aria-label="구성원 페이지" data-page={currentPage}>
      <span role="status">{filtered.length === 0 ? 0 : offset + 1}–{Math.min(offset + 10, filtered.length)} / {filtered.length}명 · {currentPage}/{pageCount} 페이지</span>
      <Button tone="neutral" size="small" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>이전</Button>
      <Button tone="neutral" size="small" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>다음</Button>
    </nav>
  </SectionCard></div>;
}
