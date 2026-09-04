export type ScreenSection =
  | "home"
  | "work"
  | "operations"
  | "people"
  | "knowledge"
  | "personal"
  | "ai"
  | "admin";

export type ScreenDefinition = Readonly<{
  id: string;
  path: string;
  label: string;
  description: string;
  section: ScreenSection;
  endpoint: string | null;
  module: string | null;
  nav?: boolean;
  ai?: boolean;
}>;

export const publicRoutes = [
  "/login",
  "/signup",
  "/welcome",
  "/invitations",
  "/change-password",
  "/onboarding/organization",
] as const;

export const screens: readonly ScreenDefinition[] = [
  { id: "DASH-001", path: "/", label: "나의 홈", description: "오늘의 업무와 조직 흐름을 한눈에 확인합니다.", section: "home", endpoint: "/tenants/usage", module: null, nav: true },
  { id: "DASH-002", path: "/dashboard/org", label: "조직 대시보드", description: "조직의 핵심 운영 지표와 주의 항목을 봅니다.", section: "home", endpoint: "/tenants/usage", module: "analytics" },
  { id: "ORG-002", path: "/members", label: "구성원", description: "구성원, 초대, 역할과 상태를 관리합니다.", section: "people", endpoint: "/members", module: null, nav: true },
  { id: "ORG-003", path: "/org-chart", label: "조직도", description: "부서 구조와 책임자를 계층으로 확인합니다.", section: "people", endpoint: "/members/org-chart", module: null, nav: true },
  { id: "ORG-006", path: "/org-log", label: "조직 변경 로그", description: "조직도, 구성원과 브랜치에 일어난 변경을 시간순으로 확인합니다.", section: "people", endpoint: "/members/activity", module: null, nav: true },
  { id: "ORG-001", path: "/settings/organization", label: "조직 설정", description: "조직 정보, 용어와 활성 모듈을 설정합니다.", section: "admin", endpoint: "/tenants/current", module: null },
  { id: "ORG-005", path: "/settings/branches", label: "브랜치 설정", description: "부서 브랜치와 들어갈 수 있는 그룹을 설정합니다.", section: "admin", endpoint: "/members/departments", module: null },
  { id: "ORG-004", path: "/settings/roles", label: "역할과 권한", description: "역할별 권한 범위와 접근 결과를 점검합니다.", section: "admin", endpoint: "/members", module: null },
  { id: "PRJ-001", path: "/projects", label: "프로젝트", description: "목표, 일정과 책임자를 중심으로 프로젝트를 운영합니다.", section: "work", endpoint: "/projects", module: "projects", nav: true },
  { id: "PRJ-002", path: "/projects/:projectId", label: "프로젝트 상세", description: "프로젝트 진행률과 참여자, 최근 활동을 확인합니다.", section: "work", endpoint: null, module: "projects" },
  { id: "TSK-002", path: "/projects/:projectId/board", label: "프로젝트 보드", description: "업무 단계를 칸반 보드로 관리합니다.", section: "work", endpoint: "/tasks/board", module: "tasks" },
  { id: "TSK-004", path: "/projects/:projectId/timeline", label: "프로젝트 타임라인", description: "마일스톤과 의존 관계를 시간축으로 봅니다.", section: "work", endpoint: "/tasks", module: "tasks" },
  { id: "TSK-001", path: "/tasks", label: "업무", description: "내 업무와 팀 업무를 우선순위별로 정리합니다.", section: "work", endpoint: "/tasks", module: "tasks", nav: true },
  { id: "TSK-003", path: "/tasks/:taskId", label: "업무 상세", description: "담당자, 체크리스트, 댓글과 의존성을 관리합니다.", section: "work", endpoint: null, module: "tasks" },
  { id: "TSK-005", path: "/workload", label: "업무량", description: "구성원별 업무량과 병목을 비교합니다.", section: "work", endpoint: "/tasks/workload/summary", module: "tasks" },
  { id: "CAL-001", path: "/calendar", label: "캘린더", description: "개인·조직 일정과 행사를 통합해 봅니다.", section: "work", endpoint: "/calendar", module: "calendar", nav: true },
  { id: "CAL-002", path: "/calendar/:eventId", label: "일정 상세", description: "참석자, 장소와 행사 체크리스트를 확인합니다.", section: "work", endpoint: null, module: "calendar" },
  { id: "FIN-001", path: "/finance", label: "재무 홈", description: "수입, 지출, 잔액과 예산 집행률을 요약합니다.", section: "operations", endpoint: "/finance/reports/summary", module: "finance", nav: true },
  { id: "FIN-002", path: "/finance/transactions", label: "거래", description: "수입·지출 거래를 작성하고 확정합니다.", section: "operations", endpoint: "/finance/transactions", module: "finance" },
  { id: "FIN-003", path: "/finance/budgets", label: "예산", description: "예산 편성과 집행률을 관리합니다.", section: "operations", endpoint: "/finance/budgets", module: "finance" },
  { id: "FIN-004", path: "/finance/dues", label: "회비", description: "회비 규칙, 청구와 납부 상태를 관리합니다.", section: "operations", endpoint: "/finance/dues/charges", module: "finance" },
  { id: "FIN-005", path: "/finance/settlements", label: "정산", description: "비용 정산을 검토하고 승인 후 전표로 반영합니다.", section: "operations", endpoint: null, module: "finance" },
  { id: "FIN-006", path: "/finance/close", label: "마감", description: "회계기간을 마감하고 승인된 재오픈을 처리합니다.", section: "operations", endpoint: "/finance/close", module: "finance" },
  { id: "AST-001", path: "/assets", label: "자산", description: "장비와 비품의 위치, 상태와 책임자를 관리합니다.", section: "operations", endpoint: "/assets", module: "assets", nav: true },
  { id: "AST-002", path: "/assets/:assetId", label: "자산 상세", description: "자산 이력, 대여와 점검 상태를 확인합니다.", section: "operations", endpoint: null, module: "assets" },
  { id: "AST-003", path: "/assets/reservations", label: "예약", description: "자산과 공간의 예약 일정을 관리합니다.", section: "operations", endpoint: "/assets/reservations", module: "assets" },
  { id: "HR-001", path: "/hr/members/:memberId", label: "인사 프로필", description: "구성원의 소속, 근태와 온보딩 상태를 확인합니다.", section: "people", endpoint: null, module: "hr" },
  { id: "HR-002", path: "/hr/attendance", label: "근태", description: "출근·지각·결근·원격 기록과 활동시간을 관리합니다.", section: "people", endpoint: "/hr/attendance", module: "hr", nav: true },
  { id: "HR-003", path: "/hr/leave", label: "휴가", description: "휴가 잔여일과 승인 요청을 관리합니다.", section: "people", endpoint: "/hr/leaves", module: "hr", nav: true },
  { id: "HR-004", path: "/hr/recruitment", label: "모집", description: "공고, 지원자 단계와 합격자 온보딩을 관리합니다.", section: "people", endpoint: "/hr/postings", module: "hr", nav: true },
  { id: "DOC-001", path: "/documents", label: "문서", description: "조직 문서와 위키를 공간별로 정리합니다.", section: "knowledge", endpoint: "/documents", module: "documents", nav: true },
  { id: "DOC-002", path: "/documents/:documentId", label: "문서 편집", description: "문서 본문, 버전과 검토 상태를 관리합니다.", section: "knowledge", endpoint: null, module: "documents" },
  { id: "DOC-003", path: "/documents/meetings/:meetingId", label: "회의록", description: "회의 결정사항을 검토하고 후속 업무로 확정합니다.", section: "knowledge", endpoint: null, module: "documents" },
  { id: "DOC-004", path: "/documents/graph", label: "조직 지식 그래프", description: "AI Agent 가 근거로 쓰는 조직 문서를 공간·링크 관계로 묶어 3D 로 탐색합니다.", section: "knowledge", endpoint: "/documents/graph", module: "documents", nav: true },
  { id: "VLT-001", path: "/vault", label: "개인 노트", description: "개인 파일과 노트를 작성하고 폴더·태그로 관리합니다. 소유자만 볼 수 있습니다.", section: "personal", endpoint: "/vault/notes", module: "agent", nav: true },
  { id: "VLT-002", path: "/vault/graph", label: "Vault 그래프", description: "내 노트의 위키링크와 백링크 관계를 그래프로 탐색합니다.", section: "personal", endpoint: "/vault/graph", module: "agent", nav: true },
  { id: "APR-001", path: "/approvals", label: "결재", description: "내 결재함과 요청 진행 상태를 확인합니다.", section: "operations", endpoint: "/approvals/requests", module: "approvals", nav: true },
  { id: "HND-001", path: "/handover", label: "인수인계", description: "직책별 인계 패키지와 확인 상태를 관리합니다.", section: "knowledge", endpoint: "/handovers", module: "handover" },
  { id: "AGT-001", path: "/agent", label: "AI Agent", description: "권한 범위 안의 조직 데이터를 근거로 업무를 돕습니다.", section: "ai", endpoint: "/agent/conversations", module: "agent", nav: true, ai: true },
  { id: "AGT-002", path: "/agent/brief", label: "AI 브리핑", description: "오늘 필요한 업무, 승인과 위험 신호를 요약합니다.", section: "ai", endpoint: "/agent/brief", module: "agent", ai: true },
  { id: "AGT-003", path: "/agent/memory", label: "AI 기억", description: "Agent가 사용하는 개인 선호와 기억을 관리합니다.", section: "ai", endpoint: "/agent/memory", module: "agent", ai: true },
  { id: "AGT-004", path: "/agent/actions/:actionId", label: "AI 실행 검토", description: "도구 실행 전 변경 내용, 승인과 롤백 정보를 검토합니다.", section: "ai", endpoint: null, module: "agent", ai: true },
  { id: "AGT-005", path: "/agent/templates", label: "AI 템플릿", description: "반복 업무를 위한 Agent 요청 템플릿을 관리합니다.", section: "ai", endpoint: "/agent/tools", module: "agent", ai: true },
  { id: "AUT-001", path: "/automations/:workflowId/edit", label: "자동화 편집", description: "트리거, 조건과 실행 단계를 안전하게 구성합니다.", section: "operations", endpoint: null, module: "automations" },
  { id: "AUT-002", path: "/automations/runs", label: "자동화 실행 기록", description: "워크플로 실행 결과와 단계별 오류를 확인합니다.", section: "operations", endpoint: "/automations/runs", module: "automations" },
  { id: "INT-001", path: "/settings/integrations", label: "외부 연동", description: "캘린더, 메신저, 웹훅과 API 키를 관리합니다.", section: "admin", endpoint: "/integrations/connections", module: "integrations" },
  { id: "ANL-001", path: "/analytics", label: "분석", description: "KPI와 운영 보고서를 한 화면에서 비교합니다.", section: "operations", endpoint: "/analytics/dashboard", module: "analytics", nav: true },
  { id: "NOT-001", path: "/notifications", label: "알림", description: "업무, 승인과 운영 알림을 한곳에서 확인합니다.", section: "home", endpoint: null, module: null },
  { id: "SET-001", path: "/settings/approval-forms", label: "결재 양식", description: "결재 입력 항목과 승인 경로를 설정합니다.", section: "admin", endpoint: "/approvals/forms", module: "approvals" },
  { id: "ADM-001", path: "/admin", label: "관리자 콘솔", description: "조직 운영, 보안과 시스템 상태를 관리합니다.", section: "admin", endpoint: "/tenants/usage", module: null, nav: true },
  { id: "ADM-002", path: "/admin/audit", label: "감사로그", description: "변경 이력과 append-only 해시체인을 검증합니다.", section: "admin", endpoint: "/integrations/audit", module: "integrations" },
  { id: "ADM-003", path: "/admin/ai-policy", label: "AI 정책", description: "모델, 데이터 등급과 도구 실행 정책을 설정합니다.", section: "admin", endpoint: "/agent/profile", module: "agent" },
  { id: "ADM-004", path: "/admin/data", label: "데이터 관리", description: "가져오기, 내보내기와 보존 정책을 관리합니다.", section: "admin", endpoint: "/imports", module: null },
  { id: "ADM-005", path: "/admin/billing", label: "요금과 사용량", description: "플랜, AI 사용량과 비용을 확인합니다.", section: "admin", endpoint: "/agent/usage", module: "agent" },
  // ── 예약 시스템 (업무 섹션 통합 페이지) ──────────────────────────────────
  { id: "RSV-001", path: "/reserve", label: "예약", description: "공간 검색 및 예약, 내 예약 현황, 대기열 및 관리를 한곳에서 처리합니다.", section: "work", endpoint: null, module: "reservations", nav: true },
] as const;

export const allRoutePaths = [...publicRoutes, ...screens.map((screen) => screen.path)];

export const navigation = screens.filter((screen) => screen.nav);

export const sectionLabels: Readonly<Record<ScreenSection, string>> = {
  home: "홈",
  work: "업무",
  operations: "운영",
  people: "사람",
  knowledge: "지식",
  personal: "개인",
  ai: "AI",
  admin: "관리",
};
