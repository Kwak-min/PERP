// 목업(index.html)의 NAV 구조를 그대로 이식.
// 그룹/순서/라벨/아이콘은 목업 사이드바 기준으로 유지한다.

export type NavItem = { path: string; label: string; icon: string };
export type NavGroup = { group?: string; items: NavItem[] };

export const ORG_TYPES: Record<string, string> = {
  student: "학생회",
  club: "동아리",
  lab: "연구실",
  company: "기업",
};

export const NAV: NavGroup[] = [
  { items: [{ path: "/", label: "조직 대시보드", icon: "home" }] },
  {
    group: "업무",
    items: [
      { path: "/projects", label: "프로젝트", icon: "folder" },
      { path: "/tasks", label: "업무", icon: "tasks" },
      { path: "/workload", label: "업무량", icon: "bars" },
      { path: "/calendar", label: "캘린더", icon: "calendar" },
    ],
  },
  {
    group: "재무",
    items: [
      { path: "/finance", label: "재무 대시보드", icon: "wallet" },
      { path: "/finance/transactions", label: "거래·전표", icon: "receipt" },
      { path: "/finance/budgets", label: "예산", icon: "pie" },
      { path: "/finance/dues", label: "청구", icon: "coins" },
      { path: "/finance/settlements", label: "정산", icon: "upload" },
      { path: "/finance/close", label: "결산", icon: "lock" },
    ],
  },
  {
    group: "자산·인사",
    items: [
      { path: "/assets", label: "자산·재고", icon: "box" },
      { path: "/assets/reservations", label: "예약", icon: "door" },
      { path: "/hr/attendance", label: "근태", icon: "clock" },
      { path: "/hr/leave", label: "휴가", icon: "umbrella" },
    ],
  },
  {
    group: "협업",
    items: [
      { path: "/documents", label: "문서·지식", icon: "file" },
      { path: "/documents/meetings", label: "회의록", icon: "message" },
      { path: "/handover", label: "인수인계", icon: "swap" },
      { path: "/approvals", label: "승인함", icon: "stamp" },
    ],
  },
  {
    group: "개인 Vault",
    items: [
      { path: "/vault", label: "노트", icon: "book" },
      { path: "/vault/graph", label: "3D 지식 그래프", icon: "graph" },
    ],
  },
  {
    group: "관리",
    items: [
      { path: "/members", label: "회원", icon: "users" },
      { path: "/settings/roles", label: "역할·권한", icon: "shield" },
      { path: "/settings/organization", label: "조직 설정", icon: "sliders" },
      { path: "/settings/approval-forms", label: "결재 양식", icon: "stamp" },
      { path: "/settings/integrations", label: "연동 센터", icon: "plug" },
      { path: "/analytics", label: "분석·보고서", icon: "chart" },
      { path: "/admin", label: "관리자 콘솔", icon: "admin" },
      { path: "/admin/audit", label: "감사 로그", icon: "shield" },
      { path: "/admin/ai-policy", label: "AI 정책", icon: "cpu" },
      { path: "/admin/data", label: "데이터 보존", icon: "database" },
    ],
  },
];

export const NAV_PATHS = NAV.flatMap((g) => g.items.map((i) => i.path));

// 현재 경로에 가장 잘 맞는 nav 항목(최장 접두 일치)을 고른다 — 목업 sidebar() 로직과 동일.
export function bestNavPath(path: string): string | undefined {
  return NAV_PATHS.filter(
    (p) => p === path || (p !== "/" && path.startsWith(p + "/")),
  ).sort((a, b) => b.length - a.length)[0];
}
