// 목업 RBAC 카탈로그(PERMS/PERM_GROUPS/ROLE_DEFS) 이식.
export const PERMS: Record<string, string> = {
  "dashboard.org.read": "조직 대시보드 보기",
  "member.read": "회원 목록 보기",
  "member.invite": "회원 초대",
  "member.manage": "회원 관리",
  "member.pii": "개인정보 열람",
  "role.manage": "역할·권한 관리",
  "org.settings": "조직 설정",
  "project.read": "프로젝트 보기",
  "project.write": "프로젝트 편집",
  "task.write": "업무 편집",
  "calendar.write": "일정 편집",
  "finance.read": "재무 보기",
  "finance.write": "전표 작성",
  "finance.confirm": "전표 확정",
  "finance.close": "결산·마감",
  "dues.write": "회비 기록",
  "settlement.write": "정산 신청",
  "asset.read": "자산 보기",
  "asset.write": "자산 관리",
  "reservation.write": "공간·장비 예약",
  "hr.read": "인사 보기",
  "hr.manage": "인사 관리",
  "leave.request": "휴가·불참 신청",
  "doc.read": "문서 보기",
  "doc.write": "문서 편집",
  "doc.sensitive": "민감 문서 열람",
  "handover.write": "인수인계 관리",
  "approval.read": "승인함",
  "approval.forms": "결재 양식 관리",
  "agent.use": "AI Agent 사용",
  "agent.approve": "AI 실행 승인",
  "automation.write": "자동화 편집",
  "ai.policy": "AI 정책 관리",
  "integration.manage": "연동 관리",
  "analytics.read": "분석 보기",
  "audit.read": "감사로그 보기",
  "audit.export": "감사로그 내보내기",
  "data.manage": "데이터 보존·내보내기",
};

export const PERM_GROUPS: Array<[string, string[]]> = [
  ["조직·회원", ["dashboard.org.read", "member.read", "member.invite", "member.manage", "member.pii", "role.manage", "org.settings"]],
  ["업무·일정", ["project.read", "project.write", "task.write", "calendar.write"]],
  ["재무", ["finance.read", "finance.write", "finance.confirm", "finance.close", "dues.write", "settlement.write"]],
  ["자산·인사", ["asset.read", "asset.write", "reservation.write", "hr.read", "hr.manage", "leave.request"]],
  ["문서·결재", ["doc.read", "doc.write", "doc.sensitive", "handover.write", "approval.read", "approval.forms"]],
  ["AI·자동화", ["agent.use", "agent.approve", "automation.write", "ai.policy"]],
  ["관리", ["integration.manage", "analytics.read", "audit.read", "audit.export", "data.manage"]],
];

export const ALL_PERMS = Object.keys(PERMS);

export type RoleDef = { key: string; name: string; perms: string[]; desc: string; count: number; version: number };
export const ROLE_DEFS: RoleDef[] = [
  { key: "owner", name: "조직 소유자", perms: ["*"], desc: "모든 권한. 마지막 소유자는 삭제·강등할 수 없습니다.", count: 1, version: 1 },
  { key: "president", name: "대표/회장", perms: ALL_PERMS.filter((p) => !["role.manage", "integration.manage", "data.manage", "ai.policy"].includes(p)), desc: "조직 대표. 고액 결재의 최종 승인자입니다.", count: 1, version: 3 },
  { key: "dept_head", name: "부서장/팀장", perms: ["dashboard.org.read", "member.read", "project.read", "project.write", "task.write", "calendar.write", "finance.read", "settlement.write", "asset.read", "asset.write", "reservation.write", "hr.read", "leave.request", "doc.read", "doc.write", "handover.write", "approval.read", "agent.use", "analytics.read"], desc: "부서 업무·휴가 승인을 담당합니다.", count: 2, version: 2 },
  { key: "treasurer", name: "총무/회계", perms: ["dashboard.org.read", "member.read", "project.read", "task.write", "calendar.write", "finance.read", "finance.write", "finance.confirm", "finance.close", "dues.write", "settlement.write", "asset.read", "reservation.write", "leave.request", "doc.read", "doc.write", "handover.write", "approval.read", "agent.use", "agent.approve", "analytics.read"], desc: "전표·예산·회비·결산을 담당합니다.", count: 1, version: 4 },
  { key: "member", name: "일반 구성원", perms: ["member.read", "project.read", "task.write", "calendar.write", "settlement.write", "asset.read", "reservation.write", "leave.request", "doc.read", "doc.write", "approval.read", "agent.use"], desc: "기본 업무·문서·일정 권한.", count: 8, version: 1 },
  { key: "external", name: "외부 협력자", perms: ["project.read", "task.write", "doc.read"], desc: "초대된 프로젝트 범위만 접근합니다.", count: 2, version: 1 },
  { key: "auditor", name: "감사자/열람자", perms: ["dashboard.org.read", "member.read", "project.read", "finance.read", "asset.read", "hr.read", "doc.read", "approval.read", "analytics.read", "audit.read", "audit.export"], desc: "읽기 전용. 감사로그 열람·내보내기.", count: 1, version: 1 },
];

export const roleHas = (r: RoleDef, p: string) => r.perms.includes("*") || r.perms.includes(p);
