// 표시 문구가 아니라 API의 원시 status 값으로 필터링한다.
// 서버가 제공하지 않는 '내 업무', '수입/지출' 등의 추정 필터는 표시하지 않는다.
type RecordStatus =
  | "active" | "inactive" | "invited" | "left" | "completed" | "archived"
  | "todo" | "in_progress" | "done" | "blocked" | "cancelled"
  | "draft" | "closed" | "confirmed" | "pending" | "approved" | "rejected"
  | "unpaid" | "partial" | "paid" | "waived" | "overdue"
  | "stored" | "in_use" | "repair" | "disposed" | "lost"
  | "reserved" | "checked_out" | "returned" | "running" | "succeeded" | "failed";

export type ScreenFilter =
  | Readonly<{ kind: "all"; id: "all"; label: string }>
  | Readonly<{ kind: "status"; id: RecordStatus; label: string; values: readonly RecordStatus[] }>;

export const allFilter: ScreenFilter = { kind: "all", id: "all", label: "전체" };

const status = (id: RecordStatus, label: string): ScreenFilter => ({ kind: "status", id, label, values: [id] });

export const screenFilters: Readonly<Record<string, readonly ScreenFilter[]>> = {
  "ORG-002": [allFilter, status("active", "활성"), status("invited", "초대 대기"), status("inactive", "휴면"), status("left", "탈퇴")],
  "PRJ-001": [allFilter, status("active", "진행"), status("completed", "완료"), status("archived", "보관")],
  "TSK-001": [allFilter, status("todo", "할 일"), status("in_progress", "진행"), status("done", "완료"), status("blocked", "차단"), status("cancelled", "취소")],
  "FIN-002": [allFilter, status("confirmed", "확정"), status("pending", "미확정")],
  "FIN-003": [allFilter, status("draft", "초안"), status("active", "활성"), status("closed", "마감")],
  "FIN-004": [allFilter, status("paid", "납부"), status("unpaid", "미납"), status("partial", "부분 납부"), status("overdue", "연체"), status("waived", "면제")],
  "FIN-005": [allFilter, status("pending", "검토 대기"), status("approved", "승인"), status("rejected", "반려")],
  "AST-001": [allFilter, status("stored", "보관"), status("in_use", "사용 중"), status("repair", "수리"), status("disposed", "폐기"), status("lost", "분실")],
  "AST-003": [allFilter, status("reserved", "예약"), status("checked_out", "대여 중"), status("returned", "반납"), status("cancelled", "취소")],
  "APR-001": [allFilter, status("pending", "대기"), status("approved", "승인"), status("rejected", "반려")],
  "AUT-002": [allFilter, status("running", "실행 중"), status("succeeded", "성공"), status("failed", "실패"), status("cancelled", "취소")],
  "NOT-001": [allFilter, status("pending", "읽지 않음"), status("done", "읽음")],
};
