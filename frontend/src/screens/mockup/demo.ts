// 목업과 동일한 화면 시연을 위한 데모 데이터.
// 백엔드 없이도 목업 디자인을 그대로 확인할 수 있도록 대표값을 담는다.
import type { MonthPoint } from "./lib";

export const orgMonthly: MonthPoint[] = [
  { ym: "2026-04", inc: 1_800_000, exp: 1_240_000 },
  { ym: "2026-05", inc: 2_150_000, exp: 1_690_000 },
  { ym: "2026-06", inc: 1_420_000, exp: 1_880_000 },
  { ym: "2026-07", inc: 2_640_000, exp: 1_510_000 },
  { ym: "2026-08", inc: 1_980_000, exp: 2_120_000 },
  { ym: "2026-09", inc: 2_460_000, exp: 1_740_000 },
];

export type Risk = { lv: "높음" | "보통"; text: string; sub: string; href: string };

export const orgRisks: Risk[] = [
  { lv: "높음", text: "기한 초과 업무 · 정기총회 준비 자료 취합", sub: "이서연 · 9.10 (목)", href: "/tasks" },
  { lv: "높음", text: "예산 집행률 104% · 학술부 세미나", sub: "1,040,000원 / 1,000,000원", href: "/finance/budgets" },
  { lv: "보통", text: "재고 임계치 미만 · 무선 마이크", sub: "1 / 최소 3", href: "/assets" },
  { lv: "보통", text: "예산 집행률 92% · 홍보물 제작", sub: "460,000원 / 500,000원", href: "/finance/budgets" },
];

export type DeptRow = {
  name: string;
  people: number;
  active: number;
  done: number;
  overdue: number;
};

export const orgDepts: DeptRow[] = [
  { name: "운영국", people: 6, active: 5, done: 12, overdue: 1 },
  { name: "학술부", people: 4, active: 3, done: 7, overdue: 2 },
  { name: "홍보부", people: 5, active: 4, done: 9, overdue: 0 },
  { name: "재무부", people: 3, active: 1, done: 5, overdue: 0 },
];

export const orgKpi = {
  activeProjects: 4,
  tasksDone: 33,
  tasksTotal: 51,
  overdue: 3,
  budgetRate: 72,
  budgetUsed: 8_640_000,
  budgetTotal: 12_000_000,
  duesRate: 85,
  duesPaid: 51,
  duesTarget: 60,
};

/* ---------- 업무(TSK-001) 데모 ---------- */
export type DemoTask = {
  id: number;
  title: string;
  project: string;
  assignee: string;
  status: "todo" | "doing" | "review" | "done";
  priority: "높음" | "보통" | "낮음";
  due: string;
  ai?: boolean;
  source?: string;
};

export const demoTasks: DemoTask[] = [
  { id: 1, title: "정기총회 준비 자료 취합", project: "2026 정기총회", assignee: "이서연", status: "doing", priority: "높음", due: "2026-09-10" },
  { id: 2, title: "학술 세미나 연사 섭외", project: "가을 학술제", assignee: "박준호", status: "todo", priority: "높음", due: "2026-09-18" },
  { id: 3, title: "홍보 포스터 시안 검토", project: "가을 학술제", assignee: "김민지", status: "review", priority: "보통", due: "2026-09-16", ai: true, source: "회의록 2026-09-05" },
  { id: 4, title: "예산 집행 내역 정리", project: "회계 운영", assignee: "김경준", status: "doing", priority: "보통", due: "2026-09-20" },
  { id: 5, title: "신입 부원 오리엔테이션 자료", project: "조직 운영", assignee: "정하늘", status: "todo", priority: "낮음", due: "2026-09-25" },
  { id: 6, title: "지난 행사 회계 마감", project: "회계 운영", assignee: "김경준", status: "done", priority: "보통", due: "2026-09-02" },
  { id: 7, title: "동아리방 비품 재고 점검", project: "조직 운영", assignee: "정하늘", status: "todo", priority: "보통", due: "2026-09-14" },
  { id: 8, title: "학술제 부스 배치도 확정", project: "가을 학술제", assignee: "박준호", status: "review", priority: "높음", due: "2026-09-15" },
];

export const demoProjectsList = ["2026 정기총회", "가을 학술제", "회계 운영", "조직 운영"];
export const demoMembers = ["김경준", "이서연", "박준호", "김민지", "정하늘"];

/* ---------- 프로젝트(PRJ-001) 데모 ---------- */
export type DemoProject = {
  id: number;
  name: string;
  desc: string;
  status: "진행" | "계획" | "완료" | "보류";
  owner: string;
  members: string[];
  start: string;
  end: string;
  budget: number;
  done: number;
  total: number;
};

export const demoProjects: DemoProject[] = [
  { id: 1, name: "2026 정기총회", desc: "상반기 결산 보고와 임원 선출을 위한 정기총회 준비", status: "진행", owner: "이서연", members: ["이서연", "김경준", "정하늘"], start: "2026-08-20", end: "2026-09-30", budget: 1_500_000, done: 6, total: 10 },
  { id: 2, name: "가을 학술제", desc: "학과 학술 세미나와 부스 운영 행사", status: "진행", owner: "박준호", members: ["박준호", "김민지", "정하늘", "이서연"], start: "2026-09-01", end: "2026-10-15", budget: 3_200_000, done: 4, total: 12 },
  { id: 3, name: "회계 운영", desc: "분기 회계 마감과 예산 집행 관리", status: "진행", owner: "김경준", members: ["김경준"], start: "2026-07-01", end: "2026-12-31", budget: 800_000, done: 8, total: 11 },
  { id: 4, name: "조직 운영", desc: "부원 관리와 정기 회의 운영", status: "계획", owner: "정하늘", members: ["정하늘", "김민지"], start: "2026-09-01", end: "2026-11-30", budget: 500_000, done: 2, total: 6 },
];
export const PROJ_TONE: Record<string, string> = { 진행: "info", 계획: "muted", 완료: "ok", 보류: "warn", 보관: "muted" };

/* ---------- 재무(FIN-001) 데모 ---------- */
export const finKpi = {
  inc: 2_460_000,
  exp: 1_740_000,
  expCount: 14,
  balance: 6_820_000,
  drafts: 3,
  draftSum: 540_000,
  budgetRate: 72,
  budgetUsed: 8_640_000,
  budgetTotal: 12_000_000,
};

export const expenseByAccount: { name: string; v: number }[] = [
  { name: "행사·운영비", v: 3_120_000 },
  { name: "물품·비품", v: 2_040_000 },
  { name: "인쇄·홍보", v: 1_280_000 },
  { name: "다과·식비", v: 860_000 },
  { name: "교통·기타", v: 420_000 },
];

export const finPeriods: { ym: string; locked: boolean; note: string }[] = [
  { ym: "2026-09", locked: false, note: "초안 3건" },
  { ym: "2026-08", locked: true, note: "마감 9.2 10:14 · 김경준" },
  { ym: "2026-07", locked: true, note: "마감 8.3 09:40 · 김경준" },
];

/* ---------- 회원(ORG-002) 데모 ---------- */
export type DemoMember = {
  name: string;
  title: string;
  email: string;
  phone: string;
  role: string;
  dept: string;
  status: "active" | "inactive" | "withdrawn";
  joinedAt: string;
};

export const demoMemberRows: DemoMember[] = [
  { name: "김경준", title: "회장", email: "rudwns1536@gmail.com", phone: "010-1234-5678", role: "운영진", dept: "운영국", status: "active", joinedAt: "2025-03-02" },
  { name: "이서연", title: "부회장", email: "seoyeon@example.com", phone: "010-2345-6789", role: "운영진", dept: "운영국", status: "active", joinedAt: "2025-03-02" },
  { name: "박준호", title: "학술부장", email: "junho@example.com", phone: "010-3456-7890", role: "부서장", dept: "학술부", status: "active", joinedAt: "2025-03-10" },
  { name: "김민지", title: "홍보부원", email: "minji@example.com", phone: "010-4567-8901", role: "일반", dept: "홍보부", status: "active", joinedAt: "2025-09-01" },
  { name: "정하늘", title: "총무", email: "haneul@example.com", phone: "010-5678-9012", role: "운영진", dept: "재무부", status: "active", joinedAt: "2025-03-02" },
  { name: "최우진", title: "일반부원", email: "woojin@example.com", phone: "010-6789-0123", role: "일반", dept: "학술부", status: "inactive", joinedAt: "2024-03-04" },
];

export const demoInvites: { email: string; role: string; invitedBy: string; expiresAt: string; expired: boolean }[] = [
  { email: "newbie@example.com", role: "일반", invitedBy: "김경준", expiresAt: "2026-09-20", expired: false },
  { email: "late@example.com", role: "일반", invitedBy: "이서연", expiresAt: "2026-09-05", expired: true },
];

export const MEM_TONE: Record<string, string> = { active: "ok", inactive: "muted", withdrawn: "muted" };
export const MEM_LABEL: Record<string, string> = { active: "활성", inactive: "비활성", withdrawn: "탈퇴(익명화)" };
export const demoRoles = ["운영진", "부서장", "일반"];

/* ---------- 자산(AST-001) 데모 ---------- */
export type DemoAsset = {
  id: number;
  code: string;
  name: string;
  category: string;
  location: string;
  owner: string;
  qty: number;
  minQty?: number;
  status: "사용가능" | "대여중" | "수리중" | "파손 보고" | "폐기";
};

export const demoAssets: DemoAsset[] = [
  { id: 1, code: "AST-0001", name: "무선 마이크", category: "음향장비", location: "동아리방 A", owner: "정하늘", qty: 1, minQty: 3, status: "사용가능" },
  { id: 2, code: "AST-0002", name: "빔 프로젝터", category: "영상장비", location: "세미나실", owner: "박준호", qty: 2, status: "대여중" },
  { id: 3, code: "AST-0003", name: "접이식 테이블", category: "행사비품", location: "창고", owner: "김경준", qty: 8, status: "사용가능" },
  { id: 4, code: "AST-0004", name: "노트북 (공용)", category: "전자기기", location: "운영국", owner: "이서연", qty: 1, status: "수리중" },
  { id: 5, code: "AST-0005", name: "현수막 거치대", category: "홍보물", location: "창고", owner: "김민지", qty: 4, status: "사용가능" },
  { id: 6, code: "AST-0006", name: "A4 용지", category: "소모품", location: "운영국", owner: "정하늘", qty: 5, minQty: 10, status: "사용가능" },
];
export const AST_TONE: Record<string, string> = { 사용가능: "ok", 대여중: "info", 수리중: "warn", "파손 보고": "bad", 폐기: "muted" };
export const assetCategories = ["음향장비", "영상장비", "행사비품", "전자기기", "홍보물", "소모품"];
export const assetStatuses = ["사용가능", "대여중", "수리중", "파손 보고", "폐기"];

/* ---------- 거래·전표(FIN-002) 데모 ---------- */
export type DemoEntry = {
  id: number;
  date: string;
  type: "income" | "expense";
  account: string;
  accountCode: string;
  vendor: string;
  memo: string;
  amount: number;
  status: "draft" | "confirmed";
  receipt?: boolean;
  ai?: boolean;
  project?: string;
};

export const demoEntries: DemoEntry[] = [
  { id: 1, date: "2026-09-12", type: "income", account: "회비수입", accountCode: "4100", vendor: "학생회비", memo: "9월 정기 회비", amount: 1_200_000, status: "confirmed" },
  { id: 2, date: "2026-09-10", type: "expense", account: "행사·운영비", accountCode: "5100", vendor: "OO기획", memo: "정기총회 대관료", amount: 450_000, status: "confirmed", receipt: true, project: "2026 정기총회" },
  { id: 3, date: "2026-09-08", type: "expense", account: "인쇄·홍보", accountCode: "5300", vendor: "행복인쇄", memo: "학술제 포스터 인쇄", amount: 180_000, status: "confirmed", receipt: true, project: "가을 학술제" },
  { id: 4, date: "2026-09-06", type: "income", account: "후원금", accountCode: "4200", vendor: "동문회", memo: "학술제 후원", amount: 500_000, status: "confirmed" },
  { id: 5, date: "2026-09-05", type: "expense", account: "다과·식비", accountCode: "5400", vendor: "카페베네", memo: "회의 다과", amount: 62_000, status: "draft", receipt: false, ai: true },
  { id: 6, date: "2026-09-03", type: "expense", account: "물품·비품", accountCode: "5200", vendor: "다이소", memo: "행사 소모품", amount: 88_000, status: "draft", receipt: true },
  { id: 7, date: "2026-09-02", type: "expense", account: "행사·운영비", accountCode: "5100", vendor: "OO렌탈", memo: "음향장비 대여", amount: 390_000, status: "draft", receipt: false },
];

/* ---------- 예산(FIN-003) 데모 ---------- */
export type DemoBudget = { id: number; name: string; amount: number; used: number };
export const demoBudgets: DemoBudget[] = [
  { id: 1, name: "행사·운영비", amount: 5_000_000, used: 3_120_000 },
  { id: 2, name: "물품·비품", amount: 2_500_000, used: 2_040_000 },
  { id: 3, name: "인쇄·홍보", amount: 1_500_000, used: 1_380_000 },
  { id: 4, name: "학술부 세미나", amount: 1_000_000, used: 1_040_000 },
  { id: 5, name: "다과·식비", amount: 1_200_000, used: 640_000 },
  { id: 6, name: "예비비", amount: 800_000, used: 0 },
];
export const budgetLog: { v: number; text: string; by: string; at: string }[] = [
  { v: 4, text: "학술부 세미나 800,000원 → 1,000,000원 · 2학기 예산 심의 반영", by: "김경준", at: "9.6 14:20" },
  { v: 3, text: "전용 예비비 → 인쇄·홍보 300,000원 · 포스터 추가 제작", by: "김경준", at: "9.4 11:02" },
  { v: 2, text: "행사·운영비 4,500,000원 → 5,000,000원 · 정기총회 규모 확대", by: "이서연", at: "8.28 16:45" },
];

/* ---------- 청구(FIN-004) 데모 ---------- */
export type DuesCharge = { id: number; name: string; amount: number; due: string };
export const duesCharges: DuesCharge[] = [
  { id: 1, name: "9월 회비", amount: 20000, due: "2026-09-10" },
  { id: 2, name: "학술제 참가비", amount: 15000, due: "2026-09-20" },
];
export type DuesPayer = { name: string; phone: string };
export const duesPayers: DuesPayer[] = [
  { name: "김경준", phone: "010-1234-5678" },
  { name: "이서연", phone: "010-2345-6789" },
  { name: "박준호", phone: "010-3456-7890" },
  { name: "김민지", phone: "010-4567-8901" },
  { name: "정하늘", phone: "010-5678-9012" },
  { name: "최우진", phone: "010-6789-0123" },
];
// [chargeId][payerName] = 'paid' | 'unpaid' | 'exempt'
export const duesStatusMap: Record<number, Record<string, "paid" | "unpaid" | "exempt">> = {
  1: { 김경준: "paid", 이서연: "paid", 박준호: "paid", 김민지: "unpaid", 정하늘: "paid", 최우진: "exempt" },
  2: { 김경준: "paid", 이서연: "unpaid", 박준호: "paid", 김민지: "unpaid", 정하늘: "paid", 최우진: "exempt" },
};

/* ---------- 정산(FIN-005) 데모 ---------- */
export type TlStep = { label: string; sub: string; state: "ok" | "now" | "bad" | "" };
export type DemoSettlement = {
  id: number;
  title: string;
  vendor: string;
  date: string;
  by: string;
  amount: number;
  status: "검토중" | "승인" | "반려";
  files: number;
  timeline: TlStep[];
};
export const STL_TONE: Record<string, string> = { 검토중: "warn", 승인: "ok", 반려: "bad" };
export const demoSettlements: DemoSettlement[] = [
  {
    id: 1,
    title: "학술제 부스 소품 구입",
    vendor: "다이소",
    date: "2026-09-08",
    by: "김민지",
    amount: 88000,
    status: "검토중",
    files: 2,
    timeline: [
      { label: "신청 · 원본 대조 확인", sub: "9.8 14:10 · 파일 2개 (불변)", state: "ok" },
      { label: "박준호 승인", sub: "9.9 09:20", state: "ok" },
      { label: "김경준 검토 중", sub: "", state: "now" },
      { label: "전표 확정", sub: "최종 승인 시 자동 확정", state: "" },
    ],
  },
  {
    id: 2,
    title: "정기총회 대관료",
    vendor: "OO기획",
    date: "2026-09-05",
    by: "이서연",
    amount: 450000,
    status: "승인",
    files: 1,
    timeline: [
      { label: "신청 · 원본 대조 확인", sub: "9.5 10:02 · 파일 1개 (불변)", state: "ok" },
      { label: "김경준 승인", sub: "9.5 15:40", state: "ok" },
      { label: "전표 확정", sub: "원장 반영 완료", state: "ok" },
    ],
  },
];

/* ---------- 결산(FIN-006) 데모 ---------- */
export const closeChecks: { ok: boolean; t: string; s: string }[] = [
  { ok: true, t: "초안 전표 0건", s: "모두 확정됨" },
  { ok: false, t: "3만원 이상 지출 증빙 첨부", s: "미증빙 1건" },
  { ok: false, t: "예산 초과 계정 없음", s: "학술부 세미나 104%, 인쇄·홍보 92%" },
  { ok: true, t: "거래 = 원장 = 보고서 합계 일치", s: "720,000원" },
];
export const closeReport: { name: string; type: "수입" | "지출"; v: number; rate: string }[] = [
  { name: "회비수입", type: "수입", v: 1_200_000, rate: "-" },
  { name: "후원금", type: "수입", v: 500_000, rate: "-" },
  { name: "행사·운영비", type: "지출", v: 840_000, rate: "62%" },
  { name: "인쇄·홍보", type: "지출", v: 180_000, rate: "92%" },
];
export const closePeriods: { ym: string; locked: boolean; note: string; pendingReopen?: boolean }[] = [
  { ym: "2026-09", locked: false, note: "열림 · 초안 3건" },
  { ym: "2026-08", locked: true, note: "마감 · 김경준" },
  { ym: "2026-07", locked: true, note: "마감 · 김경준", pendingReopen: true },
];

/* ---------- 업무량(TSK-005) 데모 ---------- */
// 각 구성원의 향후 14일 부하 (-1=휴가/불참, 0~3+ 겹치는 미완료 업무 수)
export type WorkloadRow = { name: string; title: string; cells: number[]; total: number };
export const demoWorkload: WorkloadRow[] = [
  { name: "김경준", title: "회장", cells: [2, 2, 1, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0], total: 9 },
  { name: "이서연", title: "부회장", cells: [3, 3, 2, 2, 1, 0, 0, 1, 1, 2, 2, 1, 0, 0], total: 8 },
  { name: "박준호", title: "학술부장", cells: [1, 2, 2, 3, 3, -1, -1, 2, 1, 1, 0, 0, 1, 1], total: 7 },
  { name: "김민지", title: "홍보부원", cells: [1, 1, 0, 0, 0, 0, 0, 1, 2, 1, 1, 0, 0, 0], total: 4 },
  { name: "정하늘", title: "총무", cells: [2, 1, 1, 0, 0, 0, 1, 1, 1, 2, 1, 1, 0, 0], total: 6 },
];

/* ---------- 캘린더(CAL-001) 데모 ---------- */
export type DemoEvent = {
  id: number;
  title: string;
  scope: "org" | "project" | "personal";
  start: string; // ISO
  end: string;
  location?: string;
  attendees: string[];
};
export const demoEvents: DemoEvent[] = [
  { id: 1, title: "운영진 정기회의", scope: "org", start: "2026-09-15T18:00", end: "2026-09-15T19:30", location: "동아리방 A", attendees: ["김경준", "이서연", "정하늘"] },
  { id: 2, title: "학술제 준비 미팅", scope: "project", start: "2026-09-16T17:00", end: "2026-09-16T18:00", location: "세미나실", attendees: ["박준호", "김민지"] },
  { id: 3, title: "포스터 마감", scope: "project", start: "2026-09-16T09:00", end: "2026-09-16T10:00", attendees: ["김민지"] },
  { id: 4, title: "정기총회", scope: "org", start: "2026-09-25T14:00", end: "2026-09-25T17:00", location: "대강당", attendees: ["김경준", "이서연", "박준호", "정하늘"] },
  { id: 5, title: "개인 일정 · 스터디", scope: "personal", start: "2026-09-14T20:00", end: "2026-09-14T22:00", attendees: ["김경준"] },
  { id: 6, title: "예산 심의", scope: "org", start: "2026-09-18T16:00", end: "2026-09-18T17:00", location: "운영국", attendees: ["김경준", "정하늘"] },
  { id: 7, title: "홍보물 검토", scope: "project", start: "2026-09-22T15:00", end: "2026-09-22T16:00", attendees: ["김민지", "이서연"] },
];

/* ---------- 문서·지식(DOC-001) 데모 ---------- */
export type DemoDoc = {
  id: number;
  title: string;
  space: string;
  grade: string;
  snippet: string;
  by: string;
  updatedAt: string;
  fav?: boolean;
  ai?: boolean;
};
export const demoDocs: DemoDoc[] = [
  { id: 1, title: "2026 정기총회 안건", space: "운영", grade: "내부", snippet: "회의 일시: 2026-09-25 14:00 · 참석자: 운영진 전원 · 안건 1. 상반기 결산 보고...", by: "이서연", updatedAt: "9.12 16:20", fav: true },
  { id: 2, title: "학술제 기획안", space: "행사", grade: "내부", snippet: "행사명: 가을 학술제 · 일시·장소: 2026-10-15 대강당 · 예산: 3,200,000원...", by: "박준호", updatedAt: "9.10 11:05", ai: true },
  { id: 3, title: "회원 개인정보 처리방침", space: "운영", grade: "민감", snippet: "수집 항목: 이름, 연락처, 학번 · 보유 기간: 회원 자격 유지 기간...", by: "김경준", updatedAt: "9.6 09:40" },
  { id: 4, title: "동아리 회칙", space: "규정", grade: "공개", snippet: "제1조 (명칭) 본회는 남부대학교 OO학생회라 한다. 제2조 (목적)...", by: "김경준", updatedAt: "8.28 14:12" },
  { id: 5, title: "예산 집행 지침", space: "재무", grade: "내부", snippet: "3만원 이상 지출은 반드시 증빙을 첨부한다. 정산은 행사 종료 후 7일 이내...", by: "정하늘", updatedAt: "8.20 10:30" },
];
export const docSpaces = ["운영", "행사", "규정", "재무"];

/* ---------- 승인함(APR-001) 데모 ---------- */
export const APPROVAL_KINDS: Record<string, string> = { expense: "지출결의", settlement: "정산", leave: "휴가·불참", reopen: "회계기간 재오픈", agent: "AI 고위험 실행" };
export const AP_TONE: Record<string, string> = { pending: "warn", approved: "ok", rejected: "bad", withdrawn: "muted" };
export const AP_LABEL: Record<string, string> = { pending: "진행 중", approved: "승인", rejected: "반려", withdrawn: "회수" };

export type DemoApproval = {
  id: number;
  kind: keyof typeof APPROVAL_KINDS;
  title: string;
  requester: string;
  amount: number | null;
  step: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  createdAt: string;
  reauth?: boolean;
  box: "inbox" | "sent" | "cc" | "done";
};
export const demoApprovals: DemoApproval[] = [
  { id: 1, kind: "settlement", title: "학술제 부스 소품 정산", requester: "김민지", amount: 88000, step: "김경준", status: "pending", createdAt: "9.8 14:10", box: "inbox" },
  { id: 2, kind: "expense", title: "정기총회 대관료 지출결의", requester: "이서연", amount: 450000, step: "김경준", status: "pending", createdAt: "9.7 11:20", box: "inbox" },
  { id: 3, kind: "agent", title: "AI 고위험 실행 · 회비 일괄 청구 발송", requester: "정하늘", amount: null, step: "김경준", status: "pending", createdAt: "9.6 09:05", box: "inbox" },
  { id: 4, kind: "expense", title: "음향장비 대여비 지출결의", requester: "박준호", amount: 1_200_000, step: "이서연", status: "pending", createdAt: "9.5 16:40", reauth: true, box: "inbox" },
  { id: 5, kind: "leave", title: "9월 정기활동 불참 신청", requester: "최우진", amount: null, step: "박준호", status: "approved", createdAt: "9.2 10:00", box: "done" },
];

/* ---------- 예약(AST-003) 데모 ---------- */
export const RES_H0 = 8;
export const RES_H1 = 22;
export type DemoResource = { id: number; name: string; kind: "공간" | "장비"; meta: string };
export const demoResources: DemoResource[] = [
  { id: 1, name: "세미나실 A", kind: "공간", meta: "30명" },
  { id: 2, name: "동아리방", kind: "공간", meta: "12명" },
  { id: 3, name: "빔 프로젝터", kind: "장비", meta: "운영국" },
  { id: 4, name: "무선 마이크 세트", kind: "장비", meta: "창고" },
];
export type DemoReservation = {
  id: number;
  resourceId: number;
  title: string;
  user: string;
  start: string; // HH:MM
  end: string;
  status: "확정" | "대기" | "체크인";
  mine?: boolean;
};
export const demoReservations: DemoReservation[] = [
  { id: 1, resourceId: 1, title: "학술제 준비 회의", user: "박준호", start: "17:00", end: "18:30", status: "확정" },
  { id: 2, resourceId: 1, title: "운영진 회의", user: "김경준", start: "19:00", end: "20:30", status: "확정", mine: true },
  { id: 3, resourceId: 2, title: "홍보 촬영", user: "김민지", start: "14:00", end: "16:00", status: "체크인" },
  { id: 4, resourceId: 2, title: "스터디", user: "김경준", start: "20:00", end: "22:00", status: "확정", mine: true },
  { id: 5, resourceId: 3, title: "세미나 대여", user: "박준호", start: "13:00", end: "15:00", status: "확정" },
  { id: 6, resourceId: 3, title: "총회 리허설", user: "이서연", start: "15:30", end: "17:00", status: "대기" },
  { id: 7, resourceId: 4, title: "정기총회", user: "이서연", start: "14:00", end: "17:00", status: "확정" },
];
export const myReservations: { title: string; date: string; start: string; end: string; resource: string; status: "확정" | "대기" | "체크인" }[] = [
  { title: "운영진 회의", date: "2026-09-14", start: "19:00", end: "20:30", resource: "세미나실 A", status: "확정" },
  { title: "스터디", date: "2026-09-14", start: "20:00", end: "22:00", resource: "동아리방", status: "확정" },
];

/* ---------- 휴가·부재(HR-003) 데모 ---------- */
export const LEAVE_TONE: Record<string, string> = { approved: "ok", pending: "warn", rejected: "bad", withdrawn: "muted" };
export const LEAVE_LABEL: Record<string, string> = { approved: "승인", pending: "결재 중", rejected: "반려", withdrawn: "회수" };
export const leaveKpi = { total: 15, used: 4, pending: 2 };
export type DemoLeave = { user?: string; type: string; days: number; start: string; end: string; reason?: string; delegate?: string; status: "approved" | "pending" | "rejected" };
export const myLeaves: DemoLeave[] = [
  { type: "시험 기간", days: 2, start: "2026-09-22", end: "2026-09-23", reason: "중간고사", status: "pending", delegate: "정하늘" },
  { type: "개인 사정", days: 1, start: "2026-08-14", end: "2026-08-14", reason: "가족 행사", status: "approved" },
  { type: "병가", days: 1, start: "2026-07-30", end: "2026-07-30", reason: "병원 방문", status: "approved" },
];
export const teamLeaves: DemoLeave[] = [
  { user: "박준호", type: "활동 불참", days: 2, start: "2026-09-19", end: "2026-09-20", status: "approved" },
  { user: "김민지", type: "개인 사정", days: 1, start: "2026-09-24", end: "2026-09-24", status: "pending" },
  { user: "김경준", type: "시험 기간", days: 2, start: "2026-09-22", end: "2026-09-23", status: "pending" },
];

/* ---------- 인수인계(HND-001) 데모 ---------- */
export type HoItem = { id: number; kind: string; label: string; done: boolean; sensitive?: boolean };
export type DemoHandover = {
  id: number;
  title: string;
  from: string;
  to: string;
  due: string;
  status: "진행" | "완료";
  fromOk: boolean;
  toOk: boolean;
  items: HoItem[];
};
export const demoHandovers: DemoHandover[] = [
  {
    id: 1,
    title: "총무 업무 인수인계 (2026)",
    from: "정하늘",
    to: "김민지",
    due: "2026-09-30",
    status: "진행",
    fromOk: false,
    toOk: false,
    items: [
      { id: 1, kind: "문서", label: "회계 운영 지침 문서", done: true },
      { id: 2, kind: "문서", label: "예산 편성 양식", done: true },
      { id: 3, kind: "계정", label: "회비 관리 스프레드시트 접근권", done: false },
      { id: 4, kind: "자산", label: "동아리 통장·법인카드", done: false, sensitive: true },
      { id: 5, kind: "반복업무", label: "매월 회비 청구 발송", done: true },
      { id: 6, kind: "반복업무", label: "분기 회계 마감", done: false },
      { id: 7, kind: "연락처", label: "학생지원팀 담당자 연락처", done: false, sensitive: true },
    ],
  },
  {
    id: 2,
    title: "홍보부장 인수인계",
    from: "이서연",
    to: "김민지",
    due: "2026-08-31",
    status: "완료",
    fromOk: true,
    toOk: true,
    items: [
      { id: 1, kind: "계정", label: "인스타그램 운영 계정", done: true },
      { id: 2, kind: "자산", label: "홍보용 카메라", done: true },
    ],
  },
];

/* ---------- 회의록(DOC-003) 데모 ---------- */
export type DemoMeeting = { id: number; title: string; date: string; attendees: string[]; followups: number; project?: string };
export const demoMeetings: DemoMeeting[] = [
  { id: 1, title: "9월 운영진 정기회의", date: "2026-09-08", attendees: ["김경준", "이서연", "정하늘", "박준호"], followups: 3, project: "조직 운영" },
  { id: 2, title: "학술제 킥오프", date: "2026-09-02", attendees: ["박준호", "김민지", "이서연"], followups: 5, project: "가을 학술제" },
  { id: 3, title: "예산 심의 회의", date: "2026-08-28", attendees: ["김경준", "정하늘"], followups: 2, project: "회계 운영" },
];

/* ---------- 알림(NOT-001) 데모 ---------- */
export type DemoNotif = { id: number; kind: "approval" | "task" | "system"; text: string; at: string; read: boolean; link?: string };
export const demoNotifs: DemoNotif[] = [
  { id: 1, kind: "approval", text: "정산 결재가 도착했습니다 · 학술제 부스 소품 88,000원", at: "9.12 14:10", read: false, link: "/approvals" },
  { id: 2, kind: "task", text: "'포스터 시안 검토' 업무에 멘션되었습니다", at: "9.12 11:20", read: false, link: "/tasks" },
  { id: 3, kind: "approval", text: "AI 고위험 실행 승인 요청 · 회비 일괄 청구 발송", at: "9.11 09:05", read: false, link: "/approvals" },
  { id: 4, kind: "system", text: "8월 회계기간이 마감되었습니다", at: "9.2 10:14", read: true, link: "/finance/close" },
  { id: 5, kind: "task", text: "'정기총회 준비 자료 취합' 업무 기한이 지났습니다", at: "9.11 09:00", read: true, link: "/tasks" },
];

/* ---------- 근태(HR-002) 데모 ---------- */
export type AttRec = { id: number; date: string; kind: string; in: string; out?: string; minutes: number };
export const myAttendance: AttRec[] = [
  { id: 1, date: "2026-09-14", kind: "정기회의", in: "18:00", out: "19:30", minutes: 90 },
  { id: 2, date: "2026-09-12", kind: "부스 준비", in: "14:00", out: "17:20", minutes: 200 },
  { id: 3, date: "2026-09-08", kind: "정기회의", in: "18:00", out: "19:40", minutes: 100 },
  { id: 4, date: "2026-09-05", kind: "멘토링", in: "16:00", out: "17:30", minutes: 90 },
];
export const teamAttendance: { name: string; kind?: string; in?: string; out?: string; status?: "종료" | "진행 중" }[] = [
  { name: "김경준", kind: "정기회의", in: "18:00", out: "19:30", status: "종료" },
  { name: "이서연", kind: "부스 준비", in: "17:00", status: "진행 중" },
  { name: "박준호" },
  { name: "김민지", kind: "행사 운영", in: "13:00", out: "16:00", status: "종료" },
  { name: "정하늘", kind: "멘토링", in: "15:00", status: "진행 중" },
];
export const attCorrections: { name: string; date: string; text: string; status: "대기" | "승인" }[] = [
  { name: "김민지", date: "2026-09-10", text: "체크아웃 누락 · 16:00 종료로 정정 요청", status: "대기" },
  { name: "박준호", date: "2026-09-06", text: "시작 시각 오기입 정정", status: "승인" },
];

/* ---------- 개인 Vault(VLT-001/002) 데모 ---------- */
export type DemoNote = {
  id: number;
  title: string;
  folder: string;
  body: string;
  pinned?: boolean;
  agent?: boolean;
  updatedAt: string;
};
export const demoNotes: DemoNote[] = [
  { id: 1, title: "학생회 운영 메모", folder: "운영", pinned: true, agent: true, body: "정기총회는 [[정기총회 준비]] 노트 참고. 예산은 [[예산 아이디어]]에 정리.\n\n- 부서별 진행상황 공유\n- 다음 회의 안건 취합", updatedAt: "9.12 16:20" },
  { id: 2, title: "정기총회 준비", folder: "운영", body: "일시: 2026-09-25 14:00\n장소: 대강당\n\n체크리스트\n- 자료 취합 → [[학생회 운영 메모]]\n- 참석 안내 발송", updatedAt: "9.11 10:05" },
  { id: 3, title: "예산 아이디어", folder: "재무", agent: true, body: "학술제 예산 재분배 검토. [[학술제 기획]]과 연계.\n\n- 예비비 → 홍보물\n- 세미나 연사비 증액", updatedAt: "9.10 09:40" },
  { id: 4, title: "학술제 기획", folder: "행사", body: "부스 6개 · 세미나 2세션.\n연계: [[예산 아이디어]]", updatedAt: "9.8 14:12" },
  { id: 5, title: "개인 회고", folder: "개인", body: "이번 학기 목표와 회고. 링크 없음.", updatedAt: "9.5 22:30" },
];
// [[링크]] 추출
export const noteLinks = (n: DemoNote): string[] => {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(n.body))) if (m[1]) out.push(m[1]);
  return [...new Set(out)];
};
