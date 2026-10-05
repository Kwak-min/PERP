import type { Bar, Progress, Slice } from "../components/data/Charts";
import type { CalendarEvent } from "../components/data/MonthCalendar";
import type { GanttTask } from "../components/data/GanttChart";
import type { KanbanColumn } from "../components/data/KanbanBoard";
import type { OrgNode } from "../components/data/OrgTree";
import type { FlowNode, GraphEdge, GraphNode } from "../components/data/Graphs";
import type { HeatRow, PermissionRow } from "../components/data/Matrix";
import type { Stat } from "../components/ui/StatCard";

export type RowItem = Readonly<{
  mark?: string;
  time?: string;
  title: string;
  subtitle?: string;
  meta?: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "ai";
  ai?: boolean;
}>;

export type TableFixture = Readonly<{
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  numeric?: readonly number[];
}>;

export type ScreenFixture = Readonly<{
  layout:
    | "dashboard" | "list" | "detail" | "calendar" | "kanban" | "gantt"
    | "orgchart" | "graph" | "flow" | "heatmap" | "matrix" | "brief" | "diff";
  stats: readonly Stat[];
  table?: TableFixture;
  rows?: readonly RowItem[];
  rowsTitle?: string;
  bars?: readonly Bar[];
  barsTitle?: string;
  slices?: readonly Slice[];
  donutValue?: string;
  donutLabel?: string;
  donutTitle?: string;
  progress?: readonly Progress[];
  progressTitle?: string;
  timeline?: readonly Readonly<{ title: string; note: string; done?: boolean }>[];
  timelineTitle?: string;
  facts?: readonly Readonly<{ key: string; value: string }>[];
  filters?: readonly string[];
  calendar?: Readonly<{ year: number; month: number; today: number; events: readonly CalendarEvent[] }>;
  kanban?: readonly KanbanColumn[];
  gantt?: Readonly<{ columns: readonly string[]; todayIndex: number; tasks: readonly GanttTask[] }>;
  orgchart?: OrgNode;
  graph?: Readonly<{ nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }>;
  flow?: readonly FlowNode[];
  heatmap?: Readonly<{ columns: readonly string[]; rows: readonly HeatRow[] }>;
  matrix?: Readonly<{ roles: readonly string[]; rows: readonly PermissionRow[] }>;
  brief?: readonly Readonly<{ kind: "priority" | "approval" | "risk"; title: string; note: string; source: string }>[];
  diff?: readonly Readonly<{ field: string; before: string; after: string }>[];
}>;

const UPDATED = "10분 전 갱신";

const weekBars: readonly Bar[] = [
  { label: "월", value: 42 }, { label: "화", value: 58 }, { label: "수", value: 71 },
  { label: "목", value: 64 }, { label: "금", value: 83 }, { label: "토", value: 21, soft: true },
  { label: "일", value: 12, soft: true },
];

const monthBars: readonly Bar[] = [
  { label: "1월", value: 180 }, { label: "2월", value: 230 }, { label: "3월", value: 205 },
  { label: "4월", value: 288 }, { label: "5월", value: 262 }, { label: "6월", value: 315 },
];

export const fixtures: Readonly<Record<string, ScreenFixture>> = {
  "DASH-001": {
    layout: "dashboard",
    stats: [
      { label: "오늘 내 업무", value: "7", unit: "건", delta: "어제 대비 +2", trend: "up", foot: UPDATED },
      { label: "결재 대기", value: "3", unit: "건", delta: "2건 지연", trend: "down", foot: UPDATED },
      { label: "이번 주 일정", value: "12", unit: "건", delta: "변동 없음", trend: "flat", foot: UPDATED },
      { label: "읽지 않은 알림", value: "9", unit: "건", delta: "신규 4건", trend: "up", foot: UPDATED },
    ],
    rowsTitle: "오늘 처리할 항목",
    rows: [
      { time: "09:00", mark: "업", title: "공연장 대관 계약서 검토", subtitle: "2026 봄 정기공연 · 이팀장", meta: "오늘 마감", tone: "danger" },
      { time: "11:30", mark: "결", title: "포스터 인쇄비 지출 결재", subtitle: "박총무 요청 · 250,000원", meta: "대기", tone: "warning" },
      { time: "14:00", mark: "회", title: "주간 운영 회의", subtitle: "동아리방 · 참석 5명", meta: "예정" },
      { time: "16:00", mark: "AI", title: "이번 주 브리핑 확인", subtitle: "근거 문서 4건 연결됨", meta: "AI", tone: "ai", ai: true },
      { time: "18:00", mark: "자", title: "무선 마이크 세트 반납", subtitle: "EQ-2026-001 · 동아리방 A", meta: "예약" },
    ],
    barsTitle: "요일별 업무 완료",
    bars: weekBars,
    progressTitle: "프로젝트 진행률",
    progress: [
      { label: "2026 봄 정기공연", value: 62, total: 100 },
      { label: "신입 모집 캠페인", value: 34, total: 100, tone: "warning" },
      { label: "장비 정비 주간", value: 88, total: 100 },
    ],
  },
  "DASH-002": {
    layout: "dashboard",
    stats: [
      { label: "활성 구성원", value: "48", unit: "명", delta: "+3 이번 달", trend: "up", foot: UPDATED },
      { label: "진행 프로젝트", value: "6", unit: "건", delta: "1건 신규", trend: "up", foot: UPDATED },
      { label: "예산 집행률", value: "38.3", unit: "%", delta: "계획 대비 -4.2%p", trend: "down", foot: UPDATED },
      { label: "미결 결재", value: "11", unit: "건", delta: "SLA 초과 2건", trend: "down", foot: UPDATED },
    ],
    barsTitle: "월별 활동량",
    bars: monthBars,
    donutTitle: "업무 상태 분포",
    donutValue: "62%",
    donutLabel: "완료율",
    slices: [
      { label: "완료", value: 124, color: "#4f46e5" },
      { label: "진행", value: 46, color: "#818cf8" },
      { label: "대기", value: 21, color: "#c7d2fe" },
      { label: "지연", value: 9, color: "#b45309" },
    ],
    rowsTitle: "주의가 필요한 항목",
    rows: [
      { mark: "!", title: "포스터 인쇄비 증빙 누락", subtitle: "재무 · 2026-02-12 거래", meta: "확인 필요", tone: "danger" },
      { mark: "!", title: "리허설 일정 확정 지연", subtitle: "업무 · 담당 이팀장", meta: "3일 지연", tone: "warning" },
      { mark: "!", title: "회비 미납 6명", subtitle: "재무 · 2026-1학기", meta: "미납", tone: "warning" },
    ],
  },
  "ORG-002": {
    layout: "list",
    stats: [
      { label: "전체 구성원", value: "48", unit: "명", delta: "+3", trend: "up", foot: UPDATED },
      { label: "활성", value: "41", unit: "명", delta: "85%", trend: "flat", foot: UPDATED },
      { label: "초대 대기", value: "3", unit: "건", delta: "만료 임박 1", trend: "down", foot: UPDATED },
      { label: "휴면·탈퇴", value: "4", unit: "명", delta: "이번 분기", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "활성", "초대 대기", "휴면"],
    table: {
      columns: ["이름", "이메일", "역할", "부서", "상태", "가입일"],
      rows: [
        ["김회장", "chair@demo.example.com", "소유자", "운영팀", "활성", "2025-03-02"],
        ["박총무", "treasurer@demo.example.com", "총무·회계", "운영팀", "활성", "2025-03-04"],
        ["이팀장", "lead@demo.example.com", "부서장", "기획팀", "활성", "2025-03-05"],
        ["최회원", "member@demo.example.com", "일반 회원", "홍보팀", "활성", "2025-09-01"],
        ["정하나", "hana@demo.example.com", "일반 회원", "기획팀", "초대 대기", "—"],
        ["오세준", "sejun@demo.example.com", "일반 회원", "홍보팀", "휴면", "2024-09-11"],
      ],
    },
  },
  "PRJ-001": {
    layout: "list",
    stats: [
      { label: "진행 프로젝트", value: "6", unit: "건", delta: "+1", trend: "up", foot: UPDATED },
      { label: "이번 달 완료", value: "2", unit: "건", delta: "목표 3건", trend: "down", foot: UPDATED },
      { label: "평균 진행률", value: "61", unit: "%", delta: "+8%p", trend: "up", foot: UPDATED },
      { label: "위험 프로젝트", value: "1", unit: "건", delta: "일정 지연", trend: "down", foot: UPDATED },
    ],
    filters: ["전체", "진행", "완료", "보관"],
    table: {
      columns: ["프로젝트", "담당", "상태", "진행률", "기간", "예산"],
      rows: [
        ["2026 봄 정기공연", "김회장", "진행", "62%", "02.01 – 03.20", "3,000,000"],
        ["신입 모집 캠페인", "이팀장", "진행", "34%", "02.10 – 04.05", "800,000"],
        ["장비 정비 주간", "박총무", "진행", "88%", "01.15 – 02.28", "450,000"],
        ["홈페이지 개편", "최회원", "대기", "0%", "04.01 – 05.30", "1,200,000"],
        ["2025 결산 보고", "박총무", "완료", "100%", "12.01 – 01.31", "0"],
      ],
    },
  },
  "TSK-001": {
    layout: "list",
    stats: [
      { label: "내 업무", value: "14", unit: "건", delta: "+3", trend: "up", foot: UPDATED },
      { label: "오늘 마감", value: "2", unit: "건", delta: "긴급 1건", trend: "down", foot: UPDATED },
      { label: "완료", value: "31", unit: "건", delta: "이번 달", trend: "up", foot: UPDATED },
      { label: "차단됨", value: "1", unit: "건", delta: "의존성 대기", trend: "down", foot: UPDATED },
    ],
    filters: ["전체", "내 업무", "오늘 마감", "차단"],
    table: {
      columns: ["업무", "담당", "프로젝트", "우선순위", "상태", "기한"],
      rows: [
        ["공연장 대관 계약", "이팀장", "봄 정기공연", "높음", "진행", "2026-03-02"],
        ["포스터 디자인 발주", "최회원", "봄 정기공연", "보통", "진행", "2026-03-10"],
        ["리허설 일정 확정", "이팀장", "봄 정기공연", "보통", "지연", "2026-03-15"],
        ["예산 집행 보고", "박총무", "봄 정기공연", "높음", "완료", "2026-02-20"],
        ["신입 설명회 준비", "정하나", "모집 캠페인", "보통", "대기", "2026-03-22"],
      ],
    },
  },
  "TSK-002": {
    layout: "kanban",
    stats: [
      { label: "전체 업무", value: "18", unit: "건", delta: "+4", trend: "up", foot: UPDATED },
      { label: "진행 중", value: "6", unit: "건", delta: "WIP 한도 5", trend: "down", foot: UPDATED },
      { label: "검토 대기", value: "3", unit: "건", delta: "평균 1.2일", trend: "flat", foot: UPDATED },
      { label: "완료", value: "7", unit: "건", delta: "이번 스프린트", trend: "up", foot: UPDATED },
    ],
    kanban: [
      { key: "todo", label: "할 일", cards: [
        { title: "무대 조명 견적 비교", assignee: "이팀장", due: "03.08", tags: ["공연"] },
        { title: "티켓 예매 페이지 문구", assignee: "최회원", due: "03.09", tags: ["홍보"] },
      ]},
      { key: "doing", label: "진행 중", limit: 5, cards: [
        { title: "공연장 대관 계약", assignee: "이팀장", due: "03.02", priority: "high", tags: ["계약"] },
        { title: "포스터 디자인 발주", assignee: "최회원", due: "03.10", tags: ["홍보"] },
        { title: "리허설 일정 확정", assignee: "이팀장", due: "03.15", priority: "high" },
        { title: "음향 장비 점검", assignee: "박총무", due: "03.11", tags: ["장비"] },
        { title: "출연진 명단 정리", assignee: "정하나", due: "03.12" },
        { title: "안전 계획 수립", assignee: "김회장", due: "03.13", priority: "high" },
      ]},
      { key: "review", label: "검토", limit: 4, cards: [
        { title: "예산 집행 보고", assignee: "박총무", due: "02.20", tags: ["재무"] },
        { title: "홍보물 최종 검수", assignee: "김회장", due: "03.05" },
        { title: "대관 계약서 법무 확인", assignee: "김회장", due: "03.06" },
      ]},
      { key: "done", label: "완료", cards: [
        { title: "공연 기획안 확정", assignee: "김회장", due: "02.10" },
        { title: "예산안 승인", assignee: "박총무", due: "02.12" },
        { title: "팀 배정", assignee: "이팀장", due: "02.14" },
      ]},
    ],
  },
  "TSK-004": {
    layout: "gantt",
    stats: [
      { label: "마일스톤", value: "4", unit: "개", delta: "1개 완료", trend: "up", foot: UPDATED },
      { label: "임계 경로", value: "23", unit: "일", delta: "+3일", trend: "down", foot: UPDATED },
      { label: "지연 업무", value: "1", unit: "건", delta: "리허설 확정", trend: "down", foot: UPDATED },
      { label: "완료 예정", value: "03.20", delta: "D-6", trend: "flat", foot: UPDATED },
    ],
    gantt: {
      columns: ["2월 1주", "2월 2주", "2월 3주", "2월 4주", "3월 1주", "3월 2주", "3월 3주", "3월 4주"],
      todayIndex: 5,
      tasks: [
        { label: "기획·예산 확정", owner: "김회장", start: 0, span: 2, progress: 100, milestone: true },
        { label: "공연장 대관 계약", owner: "이팀장", start: 1, span: 2, progress: 100 },
        { label: "홍보물 제작", owner: "최회원", start: 2, span: 3, progress: 72 },
        { label: "리허설 일정 확정", owner: "이팀장", start: 4, span: 2, progress: 35, late: true },
        { label: "무대·음향 세팅", owner: "박총무", start: 5, span: 2, progress: 20 },
        { label: "본공연 · 정산", owner: "김회장", start: 6, span: 2, progress: 0, milestone: true },
      ],
    },
  },
  "ORG-003": {
    layout: "orgchart",
    stats: [
      { label: "부서", value: "3", unit: "개", delta: "변동 없음", trend: "flat", foot: UPDATED },
      { label: "구성원", value: "48", unit: "명", delta: "+3", trend: "up", foot: UPDATED },
      { label: "임원", value: "5", unit: "명", delta: "교체 예정 1", trend: "flat", foot: UPDATED },
      { label: "공석 직책", value: "1", unit: "개", delta: "홍보팀장", trend: "down", foot: UPDATED },
    ],
    orgchart: {
      name: "김회장", title: "대표 · 조직 소유자", count: 48,
      children: [
        { name: "박총무", title: "총무국장 · 회계", count: 12, children: [
          { name: "한지원", title: "회계 담당" },
          { name: "서민재", title: "자산 담당" },
        ]},
        { name: "이팀장", title: "기획국장", count: 18, children: [
          { name: "정하나", title: "행사 기획" },
          { name: "윤태오", title: "무대 감독" },
        ]},
        { name: "(공석)", title: "홍보국장", count: 14, children: [
          { name: "최회원", title: "디자인 · 대행" },
        ]},
      ],
    },
  },
  "VLT-002": {
    layout: "graph",
    stats: [
      { label: "노드", value: "26", unit: "개", delta: "+3", trend: "up", foot: UPDATED },
      { label: "링크", value: "41", unit: "개", delta: "+6", trend: "up", foot: UPDATED },
      { label: "백링크", value: "18", unit: "개", delta: "양방향", trend: "flat", foot: UPDATED },
      { label: "고아 노드", value: "2", unit: "개", delta: "연결 필요", trend: "down", foot: UPDATED },
    ],
    graph: {
      nodes: [
        { id: "a", label: "공연 운영 노하우", x: 30, y: 20 },
        { id: "b", label: "장비 체크리스트", x: 62, y: 16 },
        { id: "c", label: "대관 절차", x: 18, y: 42 },
        { id: "d", label: "예산 협상 메모", x: 48, y: 46, tone: "muted" },
        { id: "e", label: "AI 요약", x: 78, y: 40, tone: "ai" },
        { id: "f", label: "회의 진행 팁", x: 88, y: 20, tone: "muted" },
      ],
      edges: [
        { source: "a", target: "b" }, { source: "a", target: "c" },
        { source: "b", target: "e" }, { source: "c", target: "d" }, { source: "b", target: "f" },
      ],
    },
  },
  "AUT-001": {
    layout: "flow",
    stats: [
      { label: "단계", value: "5", unit: "개", delta: "승인 1", trend: "flat", foot: UPDATED },
      { label: "버전", value: "v3", delta: "게시됨", trend: "up", foot: UPDATED },
      { label: "최근 실행", value: "12", unit: "회", delta: "성공 11", trend: "up", foot: UPDATED },
      { label: "실패율", value: "8.3", unit: "%", delta: "webhook 단계", trend: "down", foot: UPDATED },
    ],
    flow: [
      { id: "t", kind: "트리거", label: "거래가 확정되면", detail: "이벤트 · finance.transaction.confirmed" },
      { id: "c", kind: "조건", label: "금액이 500,000원 이상", detail: "amount_minor >= 500000" },
      { id: "a1", kind: "승인", label: "회장 승인 요청", detail: "결재선: 김회장 · SLA 24시간" },
      { id: "a2", kind: "액션", label: "총무에게 알림 발송", detail: "채널: 웹 + 이메일" },
      { id: "a3", kind: "액션", label: "감사 로그 기록", detail: "resource_type=transaction" },
    ],
  },
  "TSK-005": {
    layout: "heatmap",
    stats: [
      { label: "총 배정", value: "186", unit: "시간", delta: "+22", trend: "up", foot: UPDATED },
      { label: "가용 대비", value: "78", unit: "%", delta: "적정", trend: "flat", foot: UPDATED },
      { label: "과부하", value: "1", unit: "명", delta: "이팀장", trend: "down", foot: UPDATED },
      { label: "여유", value: "2", unit: "명", delta: "재배정 가능", trend: "up", foot: UPDATED },
    ],
    heatmap: {
      columns: ["월", "화", "수", "목", "금", "토", "일"],
      rows: [
        { name: "김회장", role: "대표", cells: [4, 6, 3, 5, 6, 0, 0], capacity: 30 },
        { name: "박총무", role: "총무·회계", cells: [6, 5, 7, 4, 6, 2, 0], capacity: 32 },
        { name: "이팀장", role: "기획국장", cells: [8, 7, 8, 7, 8, 3, 2], capacity: 36 },
        { name: "최회원", role: "일반 회원", cells: [2, 3, 2, 4, 3, 0, 0], capacity: 20 },
        { name: "정하나", role: "행사 기획", cells: [3, 2, 4, 3, 2, 0, 0], capacity: 20 },
      ],
    },
  },
  "ORG-004": {
    layout: "matrix",
    stats: [
      { label: "역할", value: "5", unit: "개", delta: "기본 4 + 사용자 1", trend: "flat", foot: UPDATED },
      { label: "권한 항목", value: "42", unit: "개", delta: "모듈 12개", trend: "flat", foot: UPDATED },
      { label: "최근 변경", value: "3", unit: "건", delta: "이번 달", trend: "up", foot: UPDATED },
      { label: "위험 조합", value: "0", unit: "건", delta: "검사 통과", trend: "up", foot: UPDATED },
    ],
    matrix: {
      roles: ["소유자", "총무", "부서장", "회원", "감사"],
      rows: [
        { resource: "회계 · 거래 작성", allow: [true, true, false, false, false] },
        { resource: "회계 · 조회", allow: [true, true, true, false, true] },
        { resource: "구성원 · 역할 변경", allow: [true, false, false, false, false] },
        { resource: "업무 · 작성", allow: [true, true, true, true, false] },
        { resource: "감사로그 · 내보내기", allow: [true, false, false, false, true] },
        { resource: "AI · 고위험 실행", allow: [true, false, false, false, false] },
      ],
    },
  },
  "AGT-002": {
    layout: "brief",
    stats: [
      { label: "우선 업무", value: "3", unit: "건", delta: "오늘 마감 1", trend: "down", foot: UPDATED },
      { label: "대기 결재", value: "2", unit: "건", delta: "SLA 초과 1", trend: "down", foot: UPDATED },
      { label: "위험 신호", value: "2", unit: "건", delta: "재무 1 · 일정 1", trend: "down", foot: UPDATED },
      { label: "근거 문서", value: "7", unit: "건", delta: "전부 연결됨", trend: "up", foot: UPDATED },
    ],
    brief: [
      { kind: "priority", title: "공연장 대관 계약서 오늘 마감", note: "이팀장 담당 · 미서명 상태입니다. 계약 지연 시 3월 20일 본공연 일정에 영향이 갑니다.", source: "업무 TSK-1024 · 문서 대관 절차" },
      { kind: "priority", title: "리허설 일정 확정 3일 지연", note: "선행 업무인 무대 도면 확정이 완료됐으므로 지금 진행 가능합니다.", source: "업무 TSK-1031" },
      { kind: "approval", title: "포스터 인쇄비 250,000원 결재 대기", note: "박총무 요청 · 24시간 경과. 증빙이 아직 첨부되지 않았습니다.", source: "결재 APR-233 · 거래 TXN-0112" },
      { kind: "risk", title: "포스터 인쇄 거래 증빙 누락", note: "확정 처리됐으나 영수증이 없습니다. 결산 전 보완이 필요합니다.", source: "거래 TXN-0112" },
      { kind: "risk", title: "회비 납부율 25%", note: "목표 80% 대비 크게 낮습니다. 미납 6명에게 알림 발송을 제안합니다.", source: "회비 DUE-2026-1" },
    ],
  },
  "AGT-004": {
    layout: "diff",
    stats: [
      { label: "도구", value: "confirm.transaction", delta: "고위험", trend: "down", foot: UPDATED },
      { label: "승인 상태", value: "대기", delta: "회장 승인 필요", trend: "down", foot: UPDATED },
      { label: "영향 범위", value: "3", unit: "건", delta: "거래·원장·예산", trend: "flat", foot: UPDATED },
      { label: "롤백", value: "가능", delta: "24시간 이내", trend: "up", foot: UPDATED },
    ],
    diff: [
      { field: "거래 상태", before: "draft", after: "confirmed" },
      { field: "원장 반영", before: "미반영", after: "2026-02 반영" },
      { field: "예산 집행액", before: "900,000원", after: "1,150,000원" },
      { field: "집행률", before: "30.0%", after: "38.3%" },
      { field: "감사 이벤트", before: "—", after: "transaction.confirmed 기록" },
    ],
    facts: [
      { key: "요청자", value: "박총무" },
      { key: "승인자", value: "김회장" },
      { key: "요청 시각", value: "2026-03-04 11:20" },
      { key: "재인증", value: "필요 (고액)" },
    ],
  },
  "FIN-003": {
    layout: "list",
    stats: [
      { label: "총 예산", value: "3,000,000", unit: "원", delta: "FY2026", trend: "flat", foot: UPDATED },
      { label: "집행액", value: "1,150,000", unit: "원", delta: "+250,000", trend: "down", foot: UPDATED },
      { label: "잔여", value: "1,850,000", unit: "원", delta: "61.7%", trend: "up", foot: UPDATED },
      { label: "초과 위험", value: "1", unit: "건", delta: "행사비", trend: "down", foot: UPDATED },
    ],
    filters: ["전체", "정상", "경고", "초과"],
    table: {
      columns: ["예산명", "기간", "편성액", "집행액", "잔여액", "집행률", "정책"],
      rows: [
        ["2026 봄 공연 예산", "FY2026", "3,000,000", "1,150,000", "1,850,000", "38.3%", "경고"],
        ["행사비", "FY2026", "1,000,000", "900,000", "100,000", "90.0%", "경고"],
        ["물품비", "FY2026", "500,000", "250,000", "250,000", "50.0%", "정상"],
        ["홍보비", "FY2026", "800,000", "0", "800,000", "0.0%", "정상"],
        ["예비비", "FY2026", "700,000", "0", "700,000", "0.0%", "차단"],
      ],
    },
    progressTitle: "예산 집행률",
    progress: [
      { label: "행사비", value: 90, total: 100, tone: "danger" },
      { label: "물품비", value: 50, total: 100 },
      { label: "홍보비", value: 0, total: 100 },
    ],
  },
  "AST-003": {
    layout: "list",
    stats: [
      { label: "이번 주 예약", value: "5", unit: "건", delta: "+2", trend: "up", foot: UPDATED },
      { label: "확정", value: "4", unit: "건", delta: "80%", trend: "up", foot: UPDATED },
      { label: "승인 대기", value: "1", unit: "건", delta: "공간 예약", trend: "flat", foot: UPDATED },
      { label: "충돌", value: "0", unit: "건", delta: "중복 차단됨", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "확정", "대기", "취소"],
    table: {
      columns: ["자원", "구분", "신청자", "시작", "종료", "상태"],
      rows: [
        ["무선 마이크 세트", "자산", "이팀장", "03-14 17:00", "03-14 22:00", "확정"],
        ["학생회관 대강당", "공간", "김회장", "03-14 18:00", "03-14 21:00", "확정"],
        ["프로젝터", "자산", "최회원", "03-16 13:00", "03-16 16:00", "승인 대기"],
        ["동아리방 A", "공간", "정하나", "03-18 19:00", "03-18 21:00", "확정"],
        ["접이식 테이블", "자산", "박총무", "03-20 15:00", "03-20 22:00", "확정"],
      ],
    },
  },
  "HR-004": {
    layout: "kanban",
    stats: [
      { label: "진행 공고", value: "2", unit: "건", delta: "마감 임박 1", trend: "down", foot: UPDATED },
      { label: "지원자", value: "17", unit: "명", delta: "+5", trend: "up", foot: UPDATED },
      { label: "면접 예정", value: "4", unit: "명", delta: "이번 주", trend: "flat", foot: UPDATED },
      { label: "합격", value: "2", unit: "명", delta: "온보딩 진행", trend: "up", foot: UPDATED },
    ],
    kanban: [
      { key: "applied", label: "지원 접수", cards: [
        { title: "강민수 · 기획팀", assignee: "이팀장", due: "03.02" },
        { title: "노유진 · 홍보팀", assignee: "최회원", due: "03.03" },
        { title: "배성호 · 기획팀", assignee: "이팀장", due: "03.04" },
      ]},
      { key: "screening", label: "서류 검토", limit: 5, cards: [
        { title: "임서연 · 홍보팀", assignee: "최회원", due: "03.05" },
        { title: "조은우 · 총무팀", assignee: "박총무", due: "03.05" },
      ]},
      { key: "interview", label: "면접", limit: 4, cards: [
        { title: "한도윤 · 기획팀", assignee: "김회장", due: "03.08", priority: "high" },
        { title: "문채원 · 홍보팀", assignee: "이팀장", due: "03.08" },
        { title: "신재민 · 총무팀", assignee: "박총무", due: "03.09" },
        { title: "오지호 · 기획팀", assignee: "김회장", due: "03.09" },
      ]},
      { key: "hired", label: "합격 · 온보딩", cards: [
        { title: "정하나 · 기획팀", assignee: "이팀장", due: "완료", tags: ["계정 발급"] },
        { title: "윤태오 · 기획팀", assignee: "이팀장", due: "진행", tags: ["체크리스트 3/5"] },
      ]},
    ],
  },
  "ADM-002": {
    layout: "list",
    stats: [
      { label: "총 이벤트", value: "1,204", unit: "건", delta: "+86", trend: "up", foot: UPDATED },
      { label: "체인 검증", value: "정상", delta: "손상 0건", trend: "up", foot: UPDATED },
      { label: "AI 생성", value: "37", unit: "건", delta: "전체의 3.1%", trend: "flat", foot: UPDATED },
      { label: "최근 검증", value: "10분 전", delta: "자동", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "AI 생성", "권한 변경", "재무"],
    table: {
      columns: ["시각", "행위자", "행동", "대상", "이전 해시", "현재 해시"],
      rows: [
        ["03-04 11:20", "박총무", "transaction.confirmed", "TXN-0112", "9f2a…c410", "1b7e…88d2"],
        ["03-04 10:05", "김회장", "approval.approved", "APR-233", "4c81…2a09", "9f2a…c410"],
        ["03-03 18:44", "AI Agent", "task.created", "TSK-1042", "77b0…5e31", "4c81…2a09"],
        ["03-03 09:12", "김회장", "member.role.changed", "MEM-018", "22d4…af60", "77b0…5e31"],
        ["03-02 14:30", "박총무", "budget.created", "BDG-004", "0000…0000", "22d4…af60"],
      ],
    },
  },
  "FIN-005": {
    layout: "list",
    stats: [
      { label: "대기 정산", value: "4", unit: "건", delta: "+1", trend: "down", foot: UPDATED },
      { label: "이번 달 지급", value: "620,000", unit: "원", delta: "+120,000", trend: "up", foot: UPDATED },
      { label: "OCR 검토 필요", value: "2", unit: "건", delta: "신뢰도 낮음", trend: "down", foot: UPDATED },
      { label: "평균 처리", value: "2.4", unit: "일", delta: "-0.6일", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "검토 대기", "결재 중", "지급 완료"],
    table: {
      columns: ["신청자", "내용", "금액", "OCR 신뢰도", "결재 단계", "상태"],
      rows: [
        ["최회원", "포스터 인쇄비", "250,000", "94%", "회장 승인", "결재 중"],
        ["정하나", "행사 다과비", "84,000", "61%", "총무 검토", "검토 대기"],
        ["이팀장", "무대 소품 구매", "186,000", "88%", "완료", "지급 완료"],
        ["박총무", "택배 발송비", "22,000", "45%", "총무 검토", "검토 대기"],
        ["윤태오", "장비 수리비", "78,000", "91%", "완료", "지급 완료"],
      ],
    },
  },
  "ORG-001": {
    layout: "dashboard",
    stats: [
      { label: "활성 모듈", value: "13", unit: "개", delta: "전체 19개 중", trend: "flat", foot: UPDATED },
      { label: "구성원", value: "48", unit: "명", delta: "+3", trend: "up", foot: UPDATED },
      { label: "회계연도", value: "1월", delta: "시작월", trend: "flat", foot: UPDATED },
      { label: "최근 변경", value: "2", unit: "건", delta: "이번 달", trend: "flat", foot: UPDATED },
    ],
    rowsTitle: "조직 기본 정보",
    rows: [
      { mark: "조", title: "OrbitFlow 데모 동아리", subtitle: "유형 동아리 · 통화 KRW · 시간대 Asia/Seoul", meta: "설정" },
      { mark: "용", title: "용어 프로필: 동아리", subtitle: "회원 / 임원 / 활동 참여", meta: "적용 중", tone: "success" },
      { mark: "모", title: "활성 모듈 13개", subtitle: "프로젝트, 업무, 일정, 문서, 회계, 자산, 인사, 결재, 인수인계, 자동화, 분석, 연동, AI", meta: "변경 가능" },
      { mark: "보", title: "데이터 보존 1825일", subtitle: "법적 보존 해제 상태", meta: "정책" },
    ],
    progressTitle: "설정 완성도",
    progress: [
      { label: "기본 정보", value: 100, total: 100 },
      { label: "부서 구성", value: 75, total: 100 },
      { label: "결재선 설정", value: 40, total: 100, tone: "warning" },
    ],
    timelineTitle: "최근 설정 변경",
    timeline: [
      { title: "자동화 모듈 활성화", note: "03.01 · 김회장", done: true },
      { title: "회계연도 1월로 변경", note: "02.20 · 박총무", done: true },
      { title: "결재선 규칙 보완", note: "예정" },
    ],
  },
  "FIN-004": {
    layout: "list",
    stats: [
      { label: "청구 대상", value: "48", unit: "명", delta: "2026-1학기", trend: "flat", foot: UPDATED },
      { label: "납부 완료", value: "12", unit: "명", delta: "25.0%", trend: "down", foot: UPDATED },
      { label: "미납", value: "34", unit: "명", delta: "독촉 필요", trend: "down", foot: UPDATED },
      { label: "면제", value: "2", unit: "명", delta: "장학 대상", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "납부", "미납", "면제"],
    table: {
      columns: ["회원", "규칙", "청구액", "납기", "납부일", "상태"],
      rows: [
        ["김회장", "2026-1학기 회비", "30,000", "2026-03-31", "2026-03-05", "납부"],
        ["박총무", "2026-1학기 회비", "30,000", "2026-03-31", "2026-03-06", "납부"],
        ["이팀장", "2026-1학기 회비", "30,000", "2026-03-31", "—", "미납"],
        ["최회원", "2026-1학기 회비", "30,000", "2026-03-31", "—", "미납"],
        ["정하나", "2026-1학기 회비", "30,000", "2026-03-31", "—", "면제"],
        ["오세준", "2026-1학기 회비", "30,000", "2026-03-31", "—", "미납"],
      ],
    },
    progressTitle: "학기별 납부율",
    progress: [
      { label: "2026-1학기", value: 25, total: 100, tone: "danger" },
      { label: "2025-2학기", value: 92, total: 100 },
      { label: "2025-1학기", value: 88, total: 100 },
    ],
  },
  "FIN-006": {
    layout: "list",
    stats: [
      { label: "마감 완료", value: "2", unit: "개월", delta: "2026-01, 02", trend: "up", foot: UPDATED },
      { label: "진행 중", value: "2026-03", delta: "체크리스트 3/5", trend: "flat", foot: UPDATED },
      { label: "미증빙", value: "1", unit: "건", delta: "마감 차단", trend: "down", foot: UPDATED },
      { label: "재오픈 요청", value: "0", unit: "건", delta: "승인 대기 없음", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "마감", "진행", "재오픈"],
    table: {
      columns: ["기간", "수입", "지출", "잔액", "마감일", "상태"],
      rows: [
        ["2026-03", "0", "0", "0", "—", "진행"],
        ["2026-02", "2,300,000", "1,150,000", "1,150,000", "2026-03-05", "마감"],
        ["2026-01", "480,000", "260,000", "220,000", "2026-02-04", "마감"],
        ["2025-12", "1,200,000", "980,000", "220,000", "2026-01-06", "마감"],
      ],
    },
    timelineTitle: "3월 마감 체크리스트",
    timeline: [
      { title: "거래 전건 확정", note: "24/25건 · 미확정 1건", done: true },
      { title: "증빙 첨부 확인", note: "포스터 인쇄 누락", done: false },
      { title: "예산 대비 검토", note: "집행률 38.3%", done: true },
      { title: "정산 완료 확인", note: "대기 4건" },
      { title: "기간 잠금", note: "미완료 항목 해결 후" },
    ],
  },
  "HR-003": {
    layout: "list",
    stats: [
      { label: "연차 잔여", value: "11.5", unit: "일", delta: "부여 15일", trend: "flat", foot: UPDATED },
      { label: "승인 대기", value: "2", unit: "건", delta: "SLA 1일", trend: "down", foot: UPDATED },
      { label: "이번 달 사용", value: "3", unit: "일", delta: "+1", trend: "up", foot: UPDATED },
      { label: "대직 지정", value: "2", unit: "건", delta: "확인 완료", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "대기", "승인", "반려"],
    table: {
      columns: ["신청자", "유형", "시작", "종료", "일수", "대직자", "상태"],
      rows: [
        ["최회원", "연차", "2026-03-05", "2026-03-07", "3", "정하나", "승인"],
        ["정하나", "연차", "2026-03-12", "2026-03-12", "1", "최회원", "대기"],
        ["이팀장", "병가", "2026-03-18", "2026-03-19", "2", "윤태오", "대기"],
        ["박총무", "특별", "2026-02-24", "2026-02-24", "1", "한지원", "승인"],
        ["오세준", "연차", "2026-02-10", "2026-02-14", "5", "—", "반려"],
      ],
    },
    progressTitle: "구성원별 연차 소진율",
    progress: [
      { label: "최회원 (5/15일)", value: 33, total: 100 },
      { label: "이팀장 (11/15일)", value: 73, total: 100, tone: "warning" },
      { label: "박총무 (3/15일)", value: 20, total: 100 },
    ],
  },
  "HND-001": {
    layout: "list",
    stats: [
      { label: "진행 패키지", value: "1", unit: "건", delta: "회장 인계", trend: "flat", foot: UPDATED },
      { label: "완료율", value: "62", unit: "%", delta: "+18%p", trend: "up", foot: UPDATED },
      { label: "필수 미확인", value: "3", unit: "건", delta: "완료 차단", trend: "down", foot: UPDATED },
      { label: "민감정보 제외", value: "4", unit: "건", delta: "자동 처리", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "진행", "완료", "보관"],
    table: {
      columns: ["패키지", "직책", "전임", "후임", "완료율", "기한", "상태"],
      rows: [
        ["회장 인수인계 2026", "회장", "김회장", "이팀장", "62%", "2026-03-31", "진행"],
        ["총무 인수인계 2025", "총무", "한지원", "박총무", "100%", "2025-12-20", "완료"],
        ["홍보국장 인계", "홍보국장", "오세준", "(공석)", "0%", "2026-04-15", "대기"],
      ],
    },
    timelineTitle: "회장 인계 진행",
    timeline: [
      { title: "자료 자동 수집", note: "문서 12건 · 업무 8건 · 자산 4건", done: true },
      { title: "전임 보완 작성", note: "주의사항 5건 기록", done: true },
      { title: "후임 확인 질문", note: "3건 미응답", done: false },
      { title: "관리자 최종 확인", note: "대기" },
      { title: "권한·자산 이전", note: "미시작" },
    ],
  },
  "AGT-003": {
    layout: "list",
    stats: [
      { label: "저장된 기억", value: "18", unit: "건", delta: "+2", trend: "up", foot: UPDATED },
      { label: "개인 범위", value: "14", unit: "건", delta: "본인만", trend: "flat", foot: UPDATED },
      { label: "만료 예정", value: "3", unit: "건", delta: "30일 이내", trend: "down", foot: UPDATED },
      { label: "저장 거부", value: "5", unit: "건", delta: "민감정보 차단", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "개인", "조직 공유", "만료 임박"],
    table: {
      columns: ["내용", "출처", "민감도", "사용 범위", "만료", "생성일"],
      rows: [
        ["대관은 최소 6주 전 신청", "사용자 입력", "내부", "개인", "—", "2026-02-20"],
        ["회비는 학기당 3만원", "문서 인용", "내부", "조직 공유", "—", "2026-02-15"],
        ["보고서는 표 형식 선호", "대화 학습", "개인", "개인", "2026-08-15", "2026-02-11"],
        ["음향 담당은 윤태오", "대화 학습", "내부", "개인", "2026-06-01", "2026-02-08"],
        ["월요일 오전 회의 선호", "사용자 입력", "개인", "개인", "2026-09-01", "2026-01-30"],
      ],
    },
    rowsTitle: "저장이 거부된 요청",
    rows: [
      { mark: "!", title: "계좌 비밀번호 기억 요청", subtitle: "credential 패턴 감지 · 저장 거부", meta: "차단", tone: "danger" },
      { mark: "!", title: "주민등록번호 포함 메모", subtitle: "고기밀 등급 · 저장 거부", meta: "차단", tone: "danger" },
    ],
  },
  "AGT-005": {
    layout: "list",
    stats: [
      { label: "사용 가능 도구", value: "14", unit: "개", delta: "권한 기준", trend: "flat", foot: UPDATED },
      { label: "고위험", value: "4", unit: "개", delta: "승인 필수", trend: "down", foot: UPDATED },
      { label: "템플릿", value: "6", unit: "개", delta: "+1", trend: "up", foot: UPDATED },
      { label: "이번 달 실행", value: "37", unit: "회", delta: "성공 35", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "조회", "생성", "고위험"],
    table: {
      columns: ["도구", "단계", "대상", "필요 권한", "승인", "재인증"],
      rows: [
        ["search.documents", "조회", "문서", "document.read", "불필요", "불필요"],
        ["search.tasks", "조회", "업무", "task.read", "불필요", "불필요"],
        ["create.task", "생성", "업무", "task.write", "불필요", "불필요"],
        ["draft.meeting_notes", "초안", "회의록", "meeting.write", "불필요", "불필요"],
        ["confirm.transaction", "실행", "거래", "transaction.confirm", "필요", "필요"],
        ["assign.role", "실행", "구성원", "role.assign", "필요", "필요"],
      ],
    },
    rowsTitle: "Agent 템플릿",
    rows: [
      { mark: "회", ai: true, title: "회장 Agent", subtitle: "브리핑 · 결재 요약 · 위험 신호", meta: "기본", tone: "ai" },
      { mark: "총", ai: true, title: "총무 Agent", subtitle: "거래 확인 · 예산 경고 · 회비 독촉", meta: "기본", tone: "ai" },
      { mark: "PM", ai: true, title: "PM Agent", subtitle: "업무 배정 · 지연 감지 · 회의록 초안", meta: "기본", tone: "ai" },
      { mark: "사", ai: true, title: "사용자 정의", subtitle: "도구 3개 · 프롬프트 직접 작성", meta: "사용자", tone: "ai" },
    ],
  },
  "AUT-002": {
    layout: "list",
    stats: [
      { label: "이번 달 실행", value: "42", unit: "회", delta: "+11", trend: "up", foot: UPDATED },
      { label: "성공", value: "38", unit: "회", delta: "90.5%", trend: "up", foot: UPDATED },
      { label: "실패", value: "4", unit: "회", delta: "webhook 단계", trend: "down", foot: UPDATED },
      { label: "평균 소요", value: "1.4", unit: "초", delta: "-0.2초", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "성공", "실패", "샌드박스"],
    table: {
      columns: ["실행 ID", "워크플로", "트리거", "시작", "소요", "실패 단계", "상태"],
      rows: [
        ["RUN-0142", "고액 거래 승인 요청", "거래 확정", "03-04 11:20", "1.2초", "—", "성공"],
        ["RUN-0141", "회비 미납 알림", "일정 (매주 월)", "03-02 09:00", "2.8초", "—", "성공"],
        ["RUN-0140", "외부 웹훅 통지", "업무 완료", "03-01 17:42", "5.0초", "3 · webhook", "실패"],
        ["RUN-0139", "고액 거래 승인 요청", "샌드박스 테스트", "02-28 14:10", "0.9초", "—", "성공"],
        ["RUN-0138", "신규 회원 온보딩", "회원 가입", "02-27 10:05", "1.6초", "—", "성공"],
      ],
    },
    rowsTitle: "재시도 필요",
    rows: [
      { mark: "!", title: "RUN-0140 · 3단계 webhook 실패", subtitle: "응답 504 · 지수 백오프 3회 소진", meta: "재시도", tone: "danger" },
    ],
  },
  "INT-001": {
    layout: "list",
    stats: [
      { label: "연결된 서비스", value: "3", unit: "개", delta: "+1", trend: "up", foot: UPDATED },
      { label: "정상", value: "2", unit: "개", delta: "헬스 확인", trend: "up", foot: UPDATED },
      { label: "재인증 필요", value: "1", unit: "개", delta: "구글 캘린더", trend: "down", foot: UPDATED },
      { label: "활성 API 키", value: "2", unit: "개", delta: "폐기 1", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "캘린더", "메신저", "웹훅"],
    table: {
      columns: ["제공자", "구분", "범위", "소유자", "상태", "연결일"],
      rows: [
        ["구글 캘린더", "캘린더", "calendar.read, write", "김회장", "재인증 필요", "2025-11-02"],
        ["슬랙", "메신저", "chat.write", "박총무", "정상", "2026-01-14"],
        ["구글 드라이브", "스토리지", "files.read", "이팀장", "정상", "2026-02-08"],
        ["아웃룩 캘린더", "캘린더", "—", "—", "미연결", "—"],
        ["카카오워크", "메신저", "—", "—", "미연결", "—"],
      ],
    },
    rowsTitle: "웹훅 · API 키",
    rows: [
      { mark: "W", title: "https://hooks.example.com/orbitflow", subtitle: "구독 이벤트 3개 · 최근 전송 성공", meta: "활성", tone: "success" },
      { mark: "K", title: "운영 대시보드 키", subtitle: "scope: analytics.read · 마지막 사용 2시간 전", meta: "활성", tone: "success" },
      { mark: "K", title: "구 배치 스크립트 키", subtitle: "2026-01-20 폐기됨", meta: "폐기", tone: "neutral" },
    ],
  },
  "SET-001": {
    layout: "list",
    stats: [
      { label: "양식", value: "4", unit: "개", delta: "사용 중 3", trend: "flat", foot: UPDATED },
      { label: "결재선 규칙", value: "6", unit: "개", delta: "조건부 2", trend: "flat", foot: UPDATED },
      { label: "평균 처리", value: "1.8", unit: "일", delta: "-0.4일", trend: "up", foot: UPDATED },
      { label: "SLA 초과", value: "2", unit: "건", delta: "이번 달", trend: "down", foot: UPDATED },
    ],
    filters: ["전체", "사용 중", "초안", "보관"],
    table: {
      columns: ["양식", "키", "필드", "결재선", "버전", "상태"],
      rows: [
        ["지출결의서", "expense", "6", "총무 → 회장", "v4", "사용 중"],
        ["휴가신청서", "leave", "5", "부서장 → 인사", "v2", "사용 중"],
        ["마감 재오픈", "fiscal_reopen", "3", "회장 (단독)", "v1", "사용 중"],
        ["물품구매요청", "purchase", "7", "부서장 → 총무 → 회장", "v1", "초안"],
      ],
    },
    rowsTitle: "조건부 결재선",
    rows: [
      { mark: "규", title: "금액 1,000,000원 이상", subtitle: "회장 승인 + 재인증 필수", meta: "적용 중", tone: "warning" },
      { mark: "규", title: "금액 100,000원 미만", subtitle: "총무 단독 승인", meta: "적용 중", tone: "success" },
      { mark: "규", title: "AI 생성 요청", subtitle: "사람 검토 단계 강제 삽입", meta: "적용 중", tone: "ai" },
    ],
  },
  "ADM-003": {
    layout: "matrix",
    stats: [
      { label: "허용 모델", value: "4", unit: "개", delta: "로컬 2 · 외부 2", trend: "flat", foot: UPDATED },
      { label: "기본 제공자", value: "로컬", delta: "Ollama", trend: "flat", foot: UPDATED },
      { label: "이번 달 비용", value: "US$0.42", delta: "한도 US$20", trend: "up", foot: UPDATED },
      { label: "차단된 전송", value: "3", unit: "건", delta: "고기밀 데이터", trend: "up", foot: UPDATED },
    ],
    matrix: {
      roles: ["공개", "내부", "개인", "민감", "고기밀"],
      rows: [
        { resource: "로컬 LLM (llama3.1:8b)", allow: [true, true, true, true, true] },
        { resource: "외부 · gpt-4o-mini", allow: [true, true, false, false, false] },
        { resource: "외부 · claude-3-haiku", allow: [true, true, false, false, false] },
        { resource: "RAG 문서 색인", allow: [true, true, true, false, false] },
        { resource: "기억 저장", allow: [true, true, true, false, false] },
        { resource: "고위험 도구 실행", allow: [false, true, false, false, false] },
      ],
    },
    rowsTitle: "정책 상태",
    rows: [
      { mark: "OK", title: "로컬 엔드포인트 정상", subtitle: "http://localhost:11434 · 응답 0.9초", meta: "정상", tone: "success" },
      { mark: "OK", title: "외부 폴백 허용", subtitle: "로컬 장애 시 내부 등급까지만", meta: "정책", tone: "success" },
      { mark: "!", title: "OpenRouter 키 만료 임박", subtitle: "30일 이내 교체 필요", meta: "확인", tone: "warning" },
    ],
  },
  "ADM-004": {
    layout: "list",
    stats: [
      { label: "가져오기 작업", value: "8", unit: "건", delta: "성공 7", trend: "up", foot: UPDATED },
      { label: "내보내기", value: "3", unit: "건", delta: "만료 1", trend: "flat", foot: UPDATED },
      { label: "보존 정책", value: "5", unit: "개", delta: "법적 보존 1", trend: "flat", foot: UPDATED },
      { label: "삭제 대기", value: "2", unit: "건", delta: "탈퇴자 데이터", trend: "down", foot: UPDATED },
    ],
    filters: ["전체", "가져오기", "내보내기", "보존"],
    table: {
      columns: ["작업", "종류", "전체 행", "정상", "오류", "모드", "상태"],
      rows: [
        ["IMP-0042", "구성원", "48", "46", "2", "미리보기", "검토 대기"],
        ["IMP-0041", "거래", "124", "124", "0", "확정", "완료"],
        ["IMP-0040", "자산", "36", "36", "0", "확정", "완료"],
        ["EXP-0018", "감사로그", "1,204", "1,204", "0", "CSV", "다운로드 가능"],
        ["EXP-0017", "거래", "124", "124", "0", "CSV", "만료"],
      ],
    },
    rowsTitle: "보존 정책",
    rows: [
      { mark: "보", title: "회계 · 1825일", subtitle: "법정 보존 5년 · 법적 보존 설정됨", meta: "법적 보존", tone: "warning" },
      { mark: "보", title: "지원자 개인정보 · 180일", subtitle: "채용 종료 후 자동 익명화", meta: "자동", tone: "success" },
      { mark: "보", title: "AI 요청 로그 · 365일", subtitle: "비용·품질 분석 후 삭제", meta: "자동", tone: "success" },
    ],
  },
  "ADM-005": {
    layout: "dashboard",
    stats: [
      { label: "요금제", value: "무료", delta: "동아리 교육", trend: "flat", foot: UPDATED },
      { label: "좌석", value: "48 / 60", delta: "80% 사용", trend: "down", foot: UPDATED },
      { label: "AI 비용", value: "US$0.42", delta: "한도 US$20", trend: "up", foot: UPDATED },
      { label: "저장 공간", value: "1.8", unit: "GB", delta: "한도 10GB", trend: "flat", foot: UPDATED },
    ],
    barsTitle: "월별 AI 사용량 (요청 수)",
    bars: [
      { label: "10월", value: 42 }, { label: "11월", value: 68 }, { label: "12월", value: 55 },
      { label: "1월", value: 94 }, { label: "2월", value: 128 }, { label: "3월", value: 37, soft: true },
    ],
    donutTitle: "모델별 비용 비중",
    donutValue: "0.42",
    donutLabel: "USD",
    slices: [
      { label: "로컬 (무료)", value: 74, color: "#7c3aed" },
      { label: "gpt-4o-mini", value: 38, color: "#a78bfa" },
      { label: "폴백", value: 16, color: "#ddd6fe" },
    ],
    rowsTitle: "사용량 상세",
    rows: [
      { mark: "좌", title: "좌석 48 / 60", subtitle: "초대 대기 3명 포함 · 12석 여유", meta: "80%", tone: "warning" },
      { mark: "자", title: "자동화 실행 42 / 500회", subtitle: "이번 달 · 한도 여유", meta: "8%", tone: "success" },
      { mark: "저", title: "저장 공간 1.8 / 10GB", subtitle: "증빙 파일 1.2GB · 문서 0.6GB", meta: "18%", tone: "success" },
    ],
    progressTitle: "한도 사용률",
    progress: [
      { label: "좌석", value: 80, total: 100, tone: "warning" },
      { label: "AI 예산", value: 2, total: 100 },
      { label: "저장 공간", value: 18, total: 100 },
    ],
  },
  "PRJ-002": {
    layout: "detail",
    stats: [
      { label: "진행률", value: "62", unit: "%", delta: "+8%p", trend: "up", foot: UPDATED },
      { label: "업무", value: "18", unit: "건", delta: "완료 7", trend: "up", foot: UPDATED },
      { label: "예산 집행", value: "38.3", unit: "%", delta: "1,150,000원", trend: "down", foot: UPDATED },
      { label: "잔여 기간", value: "16", unit: "일", delta: "03.20 종료", trend: "down", foot: UPDATED },
    ],
    facts: [
      { key: "프로젝트", value: "2026 봄 정기공연" },
      { key: "책임자", value: "김회장" },
      { key: "참여자", value: "이팀장, 박총무, 최회원, 정하나 (5명)" },
      { key: "기간", value: "2026-02-01 ~ 2026-03-20" },
      { key: "예산", value: "3,000,000원 (집행 1,150,000원)" },
      { key: "상태", value: "진행 · 위험 1건" },
    ],
    timelineTitle: "최근 활동",
    timeline: [
      { title: "예산 집행 보고 완료", note: "02.20 · 박총무", done: true },
      { title: "포스터 디자인 발주", note: "03.02 · 최회원", done: true },
      { title: "리허설 일정 확정 지연", note: "03.04 · 3일 초과", done: false },
      { title: "본공연", note: "03.20 예정" },
    ],
    rowsTitle: "프로젝트 업무",
    rows: [
      { mark: "업", title: "공연장 대관 계약", subtitle: "이팀장 · 03.02 마감", meta: "완료", tone: "success" },
      { mark: "업", title: "포스터 디자인 발주", subtitle: "최회원 · 03.10 마감", meta: "진행" },
      { mark: "업", title: "리허설 일정 확정", subtitle: "이팀장 · 03.15 마감", meta: "지연", tone: "danger" },
      { mark: "업", title: "예산 집행 보고", subtitle: "박총무 · 02.20 마감", meta: "완료", tone: "success" },
    ],
  },
  "TSK-003": {
    layout: "detail",
    stats: [
      { label: "상태", value: "진행", delta: "우선순위 높음", trend: "flat", foot: UPDATED },
      { label: "체크리스트", value: "3 / 5", delta: "필수 1건 미완", trend: "down", foot: UPDATED },
      { label: "남은 기간", value: "11", unit: "일", delta: "03.15 마감", trend: "down", foot: UPDATED },
      { label: "의존 업무", value: "1", unit: "건", delta: "선행 완료", trend: "up", foot: UPDATED },
    ],
    facts: [
      { key: "업무", value: "리허설 일정 확정" },
      { key: "담당자", value: "이팀장" },
      { key: "프로젝트", value: "2026 봄 정기공연" },
      { key: "기한", value: "2026-03-15" },
      { key: "추정 공수", value: "6시간" },
      { key: "선행 업무", value: "무대 도면 확정 (완료)" },
    ],
    timelineTitle: "변경 이력",
    timeline: [
      { title: "업무 생성", note: "02.14 · 김회장", done: true },
      { title: "담당자 지정: 이팀장", note: "02.15 · 김회장", done: true },
      { title: "기한 03.12 → 03.15 변경", note: "03.01 · 이팀장", done: true },
      { title: "완료 조건 미충족", note: "필수 체크리스트 1건", done: false },
    ],
    rowsTitle: "체크리스트 · 댓글",
    rows: [
      { mark: "✓", title: "출연팀 가용 시간 수집", subtitle: "체크리스트 · 필수", meta: "완료", tone: "success" },
      { mark: "✓", title: "대강당 예약 확인", subtitle: "체크리스트 · 필수", meta: "완료", tone: "success" },
      { mark: "✓", title: "음향팀 일정 조율", subtitle: "체크리스트", meta: "완료", tone: "success" },
      { mark: "□", title: "최종 타임테이블 배포", subtitle: "체크리스트 · 필수 · 미완료", meta: "차단 원인", tone: "danger" },
      { mark: "□", title: "리허설 준비물 점검", subtitle: "체크리스트", meta: "대기" },
      { mark: "말", title: "김회장: 늦어도 3/10까지 확정 부탁합니다", subtitle: "댓글 · 03.02", meta: "멘션" },
    ],
  },
  "CAL-002": {
    layout: "detail",
    stats: [
      { label: "참석 응답", value: "5 / 8", delta: "미응답 3", trend: "down", foot: UPDATED },
      { label: "소요", value: "3", unit: "시간", delta: "18:00–21:00", trend: "flat", foot: UPDATED },
      { label: "연결 자산", value: "2", unit: "건", delta: "예약 확정", trend: "up", foot: UPDATED },
      { label: "연결 업무", value: "3", unit: "건", delta: "준비 항목", trend: "flat", foot: UPDATED },
    ],
    facts: [
      { key: "일정", value: "정기공연 리허설" },
      { key: "일시", value: "2026-03-14 18:00 ~ 21:00" },
      { key: "장소", value: "학생회관 대강당" },
      { key: "화상 링크", value: "사용하지 않음" },
      { key: "주최", value: "김회장" },
      { key: "반복", value: "없음 (단일 일정)" },
    ],
    timelineTitle: "행사 준비 단계",
    timeline: [
      { title: "대관 확정", note: "02.28 완료", done: true },
      { title: "출연진 공지", note: "03.05 완료", done: true },
      { title: "타임테이블 배포", note: "03.10 예정", done: false },
      { title: "리허설 실시", note: "03.14 18:00" },
    ],
    rowsTitle: "참석자 · 연결 항목",
    rows: [
      { mark: "김", title: "김회장", subtitle: "주최 · 참석 확정", meta: "참석", tone: "success" },
      { mark: "이", title: "이팀장", subtitle: "무대 감독 · 참석 확정", meta: "참석", tone: "success" },
      { mark: "정", title: "정하나", subtitle: "행사 기획 · 미응답", meta: "대기", tone: "warning" },
      { mark: "자", title: "무선 마이크 세트 (EQ-2026-001)", subtitle: "17:00 ~ 22:00 예약", meta: "확정", tone: "success" },
      { mark: "업", title: "리허설 준비물 점검", subtitle: "연결 업무 · 최회원", meta: "진행" },
    ],
  },
  "AST-002": {
    layout: "detail",
    stats: [
      { label: "상태", value: "대여 중", delta: "이팀장", trend: "flat", foot: UPDATED },
      { label: "수량", value: "4", unit: "점", delta: "임계 1점", trend: "flat", foot: UPDATED },
      { label: "대여 횟수", value: "17", unit: "회", delta: "올해", trend: "up", foot: UPDATED },
      { label: "점검 예정", value: "12", unit: "일", delta: "03.22", trend: "flat", foot: UPDATED },
    ],
    facts: [
      { key: "자산번호", value: "EQ-2026-001" },
      { key: "이름", value: "무선 마이크 세트" },
      { key: "분류", value: "음향 장비" },
      { key: "위치", value: "동아리방 A" },
      { key: "책임자", value: "박총무" },
      { key: "QR", value: "orbitflow://asset/EQ-2026-001" },
    ],
    timelineTitle: "자산 이력",
    timeline: [
      { title: "등록", note: "2026-01-10 · 박총무", done: true },
      { title: "정기 점검", note: "2026-02-05 · 이상 없음", done: true },
      { title: "대여 (이팀장)", note: "2026-03-14 17:00 ~ 22:00", done: true },
      { title: "반납 예정", note: "2026-03-14 22:00", done: false },
      { title: "다음 점검", note: "2026-03-22" },
    ],
    rowsTitle: "대여 · 점검 기록",
    rows: [
      { mark: "대", title: "이팀장 대여", subtitle: "03.14 17:00 · 리허설 사용", meta: "진행", tone: "warning" },
      { mark: "반", title: "최회원 반납", subtitle: "02.20 · 이상 없음", meta: "완료", tone: "success" },
      { mark: "점", title: "정기 점검", subtitle: "02.05 · 박총무 · 배터리 교체", meta: "완료", tone: "success" },
      { mark: "수", title: "케이블 1개 교체", subtitle: "01.28 · 수리비 12,000원", meta: "완료", tone: "success" },
    ],
  },
  "HR-001": {
    layout: "detail",
    stats: [
      { label: "재직 기간", value: "13", unit: "개월", delta: "2025-03 입회", trend: "flat", foot: UPDATED },
      { label: "이번 달 활동", value: "18", unit: "일", delta: "142시간", trend: "up", foot: UPDATED },
      { label: "연차 잔여", value: "11.5", unit: "일", delta: "부여 15일", trend: "flat", foot: UPDATED },
      { label: "온보딩", value: "5 / 5", delta: "완료", trend: "up", foot: UPDATED },
    ],
    facts: [
      { key: "이름", value: "이팀장" },
      { key: "이메일", value: "lead@demo.example.com" },
      { key: "연락처", value: "***-****-**** (마스킹)" },
      { key: "소속", value: "기획팀 · 기획국장" },
      { key: "역할", value: "부서장 (dept_lead)" },
      { key: "입회일", value: "2025-03-05" },
    ],
    timelineTitle: "소속 · 직책 이력",
    timeline: [
      { title: "일반 회원 가입", note: "2025-03-05", done: true },
      { title: "기획팀 배정", note: "2025-04-01", done: true },
      { title: "기획국장 임명", note: "2025-09-01", done: true },
      { title: "회장 인수 예정", note: "2026-03-31" },
    ],
    rowsTitle: "활동 · 보유 자산",
    rows: [
      { mark: "근", title: "이번 달 근태 18일", subtitle: "출근 15 · 원격 2 · 지각 1", meta: "정상", tone: "success" },
      { mark: "업", title: "담당 업무 6건", subtitle: "진행 4 · 완료 2 · 지연 1", meta: "과부하", tone: "warning" },
      { mark: "자", title: "무선 마이크 세트 대여 중", subtitle: "EQ-2026-001 · 03.14 반납 예정", meta: "대여", tone: "warning" },
      { mark: "인", title: "회장 인수인계 후임", subtitle: "완료율 62% · 확인 질문 3건 미응답", meta: "진행" },
    ],
  },
  "DOC-002": {
    layout: "detail",
    stats: [
      { label: "버전", value: "v4", delta: "게시됨", trend: "up", foot: UPDATED },
      { label: "글자 수", value: "1,842", unit: "자", delta: "+312", trend: "up", foot: UPDATED },
      { label: "댓글", value: "3", unit: "건", delta: "미해결 1", trend: "down", foot: UPDATED },
      { label: "AI 색인", value: "6", unit: "청크", delta: "동기화 완료", trend: "up", foot: UPDATED },
    ],
    facts: [
      { key: "제목", value: "동아리 운영 규정" },
      { key: "공간", value: "운영" },
      { key: "작성자", value: "김회장" },
      { key: "공개 범위", value: "조직 전체" },
      { key: "민감도", value: "내부" },
      { key: "최근 수정", value: "2026-02-15 · 김회장" },
    ],
    timelineTitle: "버전 이력",
    timeline: [
      { title: "v4 게시", note: "02.15 · 회비 조항 개정", done: true },
      { title: "v3 게시", note: "01.30 · 장비 대여 절차 추가", done: true },
      { title: "v2 게시", note: "2025-11-12 · 임원 선출 규정", done: true },
      { title: "v1 초안", note: "2025-03-10 · 최초 작성", done: true },
    ],
    rowsTitle: "본문 구성 · 댓글",
    rows: [
      { mark: "1", title: "제1장 총칙", subtitle: "목적, 명칭, 회원 자격", meta: "3개 조항" },
      { mark: "2", title: "제2장 회비", subtitle: "회비는 매 학기 3만원이다", meta: "2개 조항" },
      { mark: "3", title: "제3장 예산 집행", subtitle: "예산 초과 지출은 회장 승인 필요", meta: "4개 조항" },
      { mark: "4", title: "제4장 장비 관리", subtitle: "대여는 반납 확인 후 종료", meta: "2개 조항" },
      { mark: "말", title: "박총무: 회비 감면 조항을 추가해야 합니다", subtitle: "댓글 · 02.18 · 미해결", meta: "미해결", tone: "warning" },
    ],
  },
  "DOC-003": {
    layout: "detail",
    stats: [
      { label: "안건", value: "3", unit: "건", delta: "전건 논의", trend: "flat", foot: UPDATED },
      { label: "결정사항", value: "2", unit: "건", delta: "확정 1", trend: "up", foot: UPDATED },
      { label: "후속 업무", value: "1", unit: "건", delta: "생성됨", trend: "up", foot: UPDATED },
      { label: "참석", value: "2 / 4", delta: "정족수 충족", trend: "flat", foot: UPDATED },
    ],
    facts: [
      { key: "회의", value: "2월 정기 회의" },
      { key: "일시", value: "2026-02-15 19:00" },
      { key: "장소", value: "동아리방" },
      { key: "참석", value: "김회장, 박총무" },
      { key: "작성", value: "박총무 (AI 초안 검토 후 확정)" },
      { key: "원문 근거", value: "메모 · 녹취 없음" },
    ],
    timelineTitle: "회의 진행",
    timeline: [
      { title: "안건 1: 공연 준비 현황", note: "대관 완료 보고", done: true },
      { title: "안건 2: 홍보 계획", note: "담당자 미정 → 결정 필요", done: true },
      { title: "안건 3: 회비 납부율", note: "독촉 방안 논의", done: true },
      { title: "후속 업무 확정", note: "1건 생성 · 1건 보류", done: true },
    ],
    rowsTitle: "결정사항 · 후속 업무",
    rows: [
      { mark: "결", ai: true, title: "홍보 담당자 지정 및 SNS 계정 개설", subtitle: "담당 최회원 · 기한 02.25 · 근거: \"홍보 착수 필요\"", meta: "업무 생성", tone: "ai" },
      { mark: "결", title: "회비 미납자 개별 연락", subtitle: "담당 박총무 · 기한 03.10", meta: "보류", tone: "warning" },
      { mark: "업", title: "SNS 계정 개설", subtitle: "결정사항에서 생성 · 최회원", meta: "진행" },
    ],
  },
  "CAL-001": {
    layout: "calendar",
    calendar: {
      year: 2026,
      month: 2,
      today: 14,
      events: [
        { day: 3, time: "19:00", title: "운영 회의" },
        { day: 5, time: "14:00", title: "홍보물 검수", tone: "success" },
        { day: 9, time: "18:30", title: "파트별 연습" },
        { day: 10, time: "11:00", title: "예산 검토", tone: "warning" },
        { day: 12, time: "17:00", title: "무대 도면 확정" },
        { day: 14, time: "18:00", title: "정기공연 리허설", tone: "danger" },
        { day: 14, time: "21:30", title: "장비 반납", tone: "success" },
        { day: 15, time: "19:00", title: "3월 정기 회의" },
        { day: 18, title: "무선 마이크 대여", tone: "success" },
        { day: 19, time: "16:00", title: "포스터 배포" },
        { day: 20, time: "17:00", title: "봄 정기공연 본공연", tone: "danger" },
        { day: 20, time: "21:00", title: "뒷정리·정산" },
        { day: 23, time: "10:00", title: "AI 브리핑 검토", tone: "ai" },
        { day: 25, time: "19:00", title: "신입 설명회", tone: "warning" },
        { day: 27, time: "15:00", title: "결산 준비" },
        { day: 31, time: "18:00", title: "월말 회고" },
      ],
    },
    stats: [
      { label: "이번 주 일정", value: "6", unit: "건", delta: "+2", trend: "up", foot: UPDATED },
      { label: "내 참석", value: "4", unit: "건", delta: "응답 대기 2", trend: "flat", foot: UPDATED },
      { label: "자원 예약", value: "5", unit: "건", delta: "충돌 0", trend: "flat", foot: UPDATED },
      { label: "빈 시간", value: "6.5", unit: "시간", delta: "이번 주", trend: "up", foot: UPDATED },
    ],
    rowsTitle: "다가오는 일정",
    rows: [
      { time: "03.14", mark: "행", title: "정기공연 리허설", subtitle: "학생회관 대강당 · 18:00–21:00", meta: "참석 5명" },
      { time: "03.15", mark: "회", title: "3월 정기 회의", subtitle: "동아리방 · 19:00–20:30", meta: "참석 8명" },
      { time: "03.18", mark: "예", title: "무선 마이크 대여", subtitle: "EQ-2026-001 · 종일", meta: "확정" },
      { time: "03.20", mark: "행", title: "봄 정기공연 본공연", subtitle: "학생회관 대강당 · 17:00–21:00", meta: "준비 중" },
    ],
    barsTitle: "요일별 일정 밀도",
    bars: weekBars,
    timelineTitle: "행사 준비 단계",
    timeline: [
      { title: "대관 확정", note: "02.28 완료", done: true },
      { title: "홍보물 배포", note: "03.05 완료", done: true },
      { title: "리허설", note: "03.14 예정" },
      { title: "본공연", note: "03.20 예정" },
    ],
  },
  "FIN-001": {
    layout: "dashboard",
    stats: [
      { label: "수입", value: "2,300,000", unit: "원", delta: "+15.2%", trend: "up", foot: UPDATED },
      { label: "확정 지출", value: "1,150,000", unit: "원", delta: "미확정 제외 · +8.4%", trend: "down", foot: UPDATED },
      { label: "잔액", value: "1,150,000", unit: "원", delta: "전월 대비 +21%", trend: "up", foot: UPDATED },
      { label: "예산 집행률", value: "38.3", unit: "%", delta: "계획 대비 -4.2%p", trend: "down", foot: UPDATED },
    ],
    barsTitle: "월별 수지 추이",
    bars: monthBars,
    donutTitle: "계정별 지출 비중",
    donutValue: "115만",
    donutLabel: "총 지출",
    slices: [
      { label: "행사비", value: 900000, color: "#4f46e5" },
      { label: "물품비", value: 250000, color: "#818cf8" },
    ],
    rowsTitle: "확인이 필요한 거래",
    rows: [
      { mark: "!", title: "포스터 인쇄 250,000원", subtitle: "증빙 미첨부 · 2026-02-12", meta: "증빙 필요", tone: "danger" },
      { mark: "확", title: "공연장 대관료 900,000원", subtitle: "확정 · 2026-02-10", meta: "완료", tone: "success" },
      { mark: "회", title: "학기 회비 1,500,000원", subtitle: "확정 · 2026-02-01", meta: "완료", tone: "success" },
    ],
  },
  "FIN-002": {
    layout: "list",
    stats: [
      { label: "이번 달 거래", value: "24", unit: "건", delta: "+6", trend: "up", foot: UPDATED },
      { label: "미확정", value: "3", unit: "건", delta: "검토 대기", trend: "down", foot: UPDATED },
      { label: "증빙 누락", value: "1", unit: "건", delta: "즉시 확인", trend: "down", foot: UPDATED },
      { label: "확정 지출", value: "1,150,000", unit: "원", delta: "미확정 84,000 제외", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "수입", "지출", "미확정"],
    table: {
      columns: ["일자", "구분", "적요", "계정", "금액", "상태"],
      rows: [
        ["2026-02-01", "수입", "학기 회비 수입", "회비수입", "1,500,000", "확정"],
        ["2026-02-05", "수입", "학교 지원금", "지원금", "800,000", "확정"],
        ["2026-02-10", "지출", "공연장 대관료", "행사비", "900,000", "확정"],
        ["2026-02-12", "지출", "포스터 인쇄", "물품비", "250,000", "증빙 필요"],
        ["2026-02-18", "지출", "간식비", "물품비", "84,000", "미확정"],
      ],
    },
  },
  "AST-001": {
    layout: "list",
    stats: [
      { label: "전체 자산", value: "36", unit: "점", delta: "+2", trend: "up", foot: UPDATED },
      { label: "대여 중", value: "7", unit: "점", delta: "반납 예정 3", trend: "flat", foot: UPDATED },
      { label: "점검 필요", value: "2", unit: "점", delta: "기한 초과 1", trend: "down", foot: UPDATED },
      { label: "재고 임계", value: "1", unit: "품목", delta: "케이블 여분", trend: "down", foot: UPDATED },
    ],
    filters: ["전체", "가용", "대여 중", "점검"],
    table: {
      columns: ["자산번호", "이름", "분류", "수량", "위치", "상태"],
      rows: [
        ["EQ-2026-001", "무선 마이크 세트", "음향", "4", "동아리방 A", "대여 중"],
        ["EQ-2026-002", "마이크 스탠드", "음향", "2", "동아리방 A", "가용"],
        ["EQ-2025-014", "프로젝터", "영상", "1", "창고", "점검 필요"],
        ["EQ-2025-021", "XLR 케이블", "음향", "3", "동아리방 A", "재고 임계"],
        ["FN-2024-003", "접이식 테이블", "비품", "6", "창고", "가용"],
      ],
    },
  },
  "APR-001": {
    layout: "list",
    stats: [
      { label: "받은 결재", value: "3", unit: "건", delta: "신규 1", trend: "up", foot: UPDATED },
      { label: "보낸 결재", value: "5", unit: "건", delta: "승인 3", trend: "flat", foot: UPDATED },
      { label: "SLA 초과", value: "2", unit: "건", delta: "즉시 처리", trend: "down", foot: UPDATED },
      { label: "이번 달 승인", value: "14", unit: "건", delta: "+4", trend: "up", foot: UPDATED },
    ],
    filters: ["받은", "보낸", "참조", "완료"],
    table: {
      columns: ["제목", "요청자", "양식", "금액", "상태", "요청일"],
      rows: [
        ["포스터 인쇄비 지출", "박총무", "지출결의", "250,000", "대기", "2026-02-12"],
        ["대관료 집행 승인", "김회장", "지출결의", "900,000", "승인", "2026-02-09"],
        ["휴가 신청 (3.5–3.7)", "최회원", "휴가신청", "—", "대기", "2026-03-01"],
        ["마감 재오픈 요청", "박총무", "재오픈", "—", "반려", "2026-02-28"],
      ],
    },
  },
  "AGT-001": {
    layout: "dashboard",
    stats: [
      { label: "이번 달 질의", value: "128", unit: "건", delta: "+34", trend: "up", foot: UPDATED },
      { label: "근거 제시율", value: "100", unit: "%", delta: "목표 95%", trend: "up", foot: UPDATED },
      { label: "평균 응답", value: "1.8", unit: "초", delta: "-0.4초", trend: "up", foot: UPDATED },
      { label: "승인 대기 실행", value: "1", unit: "건", delta: "고위험", trend: "down", foot: UPDATED },
    ],
    rowsTitle: "최근 대화",
    rows: [
      { mark: "AI", ai: true, title: "이번 달 예산 위험 항목 알려줘", subtitle: "근거 문서 3건 · 2분 전", meta: "완료", tone: "ai" },
      { mark: "AI", ai: true, title: "회비 규정이 어떻게 되지?", subtitle: "근거 문서 2건 · 1시간 전", meta: "완료", tone: "ai" },
      { mark: "AI", ai: true, title: "리허설 일정 업무 만들어줘", subtitle: "실행 미리보기 대기 · 3시간 전", meta: "승인 필요", tone: "warning" },
    ],
    donutTitle: "모델 라우팅 분포",
    donutValue: "128",
    donutLabel: "총 호출",
    slices: [
      { label: "로컬 (보안)", value: 74, color: "#7c3aed" },
      { label: "외부 (일반)", value: 48, color: "#a78bfa" },
      { label: "폴백", value: 6, color: "#ddd6fe" },
    ],
  },
  "ANL-001": {
    layout: "dashboard",
    stats: [
      { label: "업무 완료율", value: "62", unit: "%", delta: "+8%p", trend: "up", foot: UPDATED },
      { label: "예산 집행률", value: "38.3", unit: "%", delta: "-4.2%p", trend: "down", foot: UPDATED },
      { label: "회비 납부율", value: "25", unit: "%", delta: "목표 80%", trend: "down", foot: UPDATED },
      { label: "AI 비용", value: "US$0.42", delta: "이번 달", trend: "flat", foot: UPDATED },
    ],
    barsTitle: "월별 활동 지표",
    bars: monthBars,
    progressTitle: "부서별 목표 달성",
    progress: [
      { label: "운영팀", value: 82, total: 100 },
      { label: "기획팀", value: 61, total: 100 },
      { label: "홍보팀", value: 38, total: 100, tone: "warning" },
    ],
    rowsTitle: "저장된 보고서",
    rows: [
      { mark: "R", title: "월간 운영 보고서", subtitle: "매월 1일 자동 발송 · 수신 4명", meta: "예약" },
      { mark: "R", title: "분기 재무 요약", subtitle: "최근 생성 2026-01-05", meta: "수동" },
      { mark: "R", title: "구성원 활동 리포트", subtitle: "최근 생성 2026-02-01", meta: "수동" },
    ],
  },
  "ADM-001": {
    layout: "dashboard",
    stats: [
      { label: "활성 모듈", value: "12", unit: "개", delta: "전체 19개 중", trend: "flat", foot: UPDATED },
      { label: "저장 사용량", value: "1.8", unit: "GB", delta: "한도 10GB", trend: "flat", foot: UPDATED },
      { label: "이번 달 API", value: "8,412", unit: "회", delta: "+12%", trend: "up", foot: UPDATED },
      { label: "감사 이벤트", value: "1,204", unit: "건", delta: "체인 정상", trend: "up", foot: UPDATED },
    ],
    rowsTitle: "시스템 상태",
    rows: [
      { mark: "OK", title: "감사 해시체인 무결성", subtitle: "최근 검증 10분 전 · 손상 0건", meta: "정상", tone: "success" },
      { mark: "OK", title: "백업 복구 리허설", subtitle: "최근 수행 2026-02-01 · RPO 12h", meta: "정상", tone: "success" },
      { mark: "!", title: "OpenRouter API 키 만료 임박", subtitle: "30일 이내 교체 필요", meta: "확인", tone: "warning" },
    ],
    progressTitle: "리소스 사용률",
    progress: [
      { label: "저장 공간", value: 18, total: 100 },
      { label: "좌석 (48/60)", value: 80, total: 100, tone: "warning" },
      { label: "AI 토큰 예산", value: 42, total: 100 },
    ],
  },
  "HR-002": {
    layout: "list",
    stats: [
      { label: "이번 달 출근", value: "18", unit: "일", delta: "정상", trend: "flat", foot: UPDATED },
      { label: "지각", value: "2", unit: "회", delta: "-1", trend: "up", foot: UPDATED },
      { label: "원격", value: "4", unit: "일", delta: "+2", trend: "up", foot: UPDATED },
      { label: "총 활동시간", value: "142", unit: "시간", delta: "+16", trend: "up", foot: UPDATED },
    ],
    filters: ["전체", "출근", "지각", "원격", "휴가"],
    table: {
      columns: ["일자", "구성원", "구분", "시간", "출처", "비고"],
      rows: [
        ["2026-03-02", "김회장", "출근", "8", "QR", "—"],
        ["2026-03-02", "박총무", "원격", "8", "수동", "재택"],
        ["2026-03-03", "이팀장", "지각", "7", "QR", "교통 지연"],
        ["2026-03-04", "최회원", "출근", "8", "QR", "—"],
        ["2026-03-05", "정하나", "휴가", "0", "결재", "연차"],
      ],
    },
  },
  "DOC-001": {
    layout: "list",
    stats: [
      { label: "전체 문서", value: "84", unit: "건", delta: "+7", trend: "up", foot: UPDATED },
      { label: "이번 주 편집", value: "12", unit: "건", delta: "+4", trend: "up", foot: UPDATED },
      { label: "검토 대기", value: "3", unit: "건", delta: "기한 임박 1", trend: "down", foot: UPDATED },
      { label: "AI 색인", value: "312", unit: "청크", delta: "동기화 완료", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "규정", "회의록", "템플릿"],
    table: {
      columns: ["제목", "공간", "작성자", "버전", "상태", "수정일"],
      rows: [
        ["동아리 운영 규정", "운영", "김회장", "v4", "게시", "2026-02-15"],
        ["2월 정기 회의록", "회의", "박총무", "v2", "확정", "2026-02-15"],
        ["행사 기획 템플릿", "템플릿", "이팀장", "v1", "초안", "2026-02-11"],
        ["장비 대여 안내", "운영", "박총무", "v3", "게시", "2026-01-30"],
        ["예산 편성 지침", "재무", "박총무", "v2", "검토 대기", "2026-02-20"],
      ],
    },
  },
  "VLT-001": {
    layout: "list",
    stats: [
      { label: "내 노트", value: "26", unit: "건", delta: "+3", trend: "up", foot: UPDATED },
      { label: "위키링크", value: "41", unit: "개", delta: "+6", trend: "up", foot: UPDATED },
      { label: "고아 노트", value: "2", unit: "건", delta: "연결 필요", trend: "down", foot: UPDATED },
      { label: "AI 연동", value: "18", unit: "건", delta: "허용됨", trend: "flat", foot: UPDATED },
    ],
    filters: ["전체", "운영", "개인", "고정"],
    table: {
      columns: ["제목", "폴더", "태그", "링크", "AI 사용", "수정일"],
      rows: [
        ["공연 운영 노하우", "/운영", "공연, 운영", "2", "허용", "2026-02-20"],
        ["장비 체크리스트", "/운영", "장비", "1", "허용", "2026-02-18"],
        ["회의 진행 팁", "/개인", "회의", "0", "차단", "2026-02-10"],
        ["예산 협상 메모", "/개인", "재무", "0", "차단", "2026-01-28"],
      ],
    },
  },
  "NOT-001": {
    layout: "list",
    stats: [
      { label: "읽지 않음", value: "9", unit: "건", delta: "신규 4", trend: "up", foot: UPDATED },
      { label: "업무", value: "4", unit: "건", delta: "—", trend: "flat", foot: UPDATED },
      { label: "결재", value: "3", unit: "건", delta: "SLA 2", trend: "down", foot: UPDATED },
      { label: "시스템", value: "2", unit: "건", delta: "—", trend: "flat", foot: UPDATED },
    ],
    filters: ["읽지 않음", "업무", "결재", "시스템"],
    rowsTitle: "최근 알림",
    rows: [
      { time: "10:24", mark: "결", title: "포스터 인쇄비 결재 요청", subtitle: "박총무 · 250,000원", meta: "새 알림", tone: "warning" },
      { time: "09:10", mark: "업", title: "리허설 일정 확정 기한 임박", subtitle: "2026 봄 정기공연", meta: "새 알림", tone: "danger" },
      { time: "어제", mark: "자", title: "재고 임계치 도달: XLR 케이블", subtitle: "잔여 3개 · 임계 3", meta: "확인", tone: "warning" },
      { time: "어제", mark: "AI", ai: true, title: "오늘 브리핑이 준비되었습니다", subtitle: "우선순위 5건 정리됨", meta: "AI", tone: "ai" },
    ],
  },
};

const DEFAULT_STATS: readonly Stat[] = [
  { label: "전체 항목", value: "24", unit: "건", delta: "+3 이번 주", trend: "up", foot: UPDATED },
  { label: "완료", value: "15", unit: "건", delta: "62.5%", trend: "up", foot: UPDATED },
  { label: "진행", value: "7", unit: "건", delta: "변동 없음", trend: "flat", foot: UPDATED },
  { label: "확인 필요", value: "2", unit: "건", delta: "지연 1건", trend: "down", foot: UPDATED },
];

const DEFAULT_TABLE: TableFixture = {
  columns: ["항목", "담당", "상태", "갱신일"],
  rows: [
    ["샘플 항목 A", "김회장", "완료", "2026-03-01"],
    ["샘플 항목 B", "박총무", "진행", "2026-03-02"],
    ["샘플 항목 C", "이팀장", "진행", "2026-03-03"],
    ["샘플 항목 D", "최회원", "대기", "2026-03-04"],
  ],
};

const DETAIL_FACTS = [
  { key: "식별자", value: "DEMO-0001" },
  { key: "담당", value: "김회장" },
  { key: "상태", value: "진행" },
  { key: "생성", value: "2026-02-01" },
  { key: "최근 수정", value: "2026-03-04" },
];

export function fixtureFor(screenId: string, isDetail: boolean): ScreenFixture {
  const found = fixtures[screenId];
  if (found) return found;
  if (isDetail) {
    return {
      layout: "detail",
      stats: DEFAULT_STATS.slice(0, 3),
      facts: DETAIL_FACTS,
      timelineTitle: "활동 기록",
      timeline: [
        { title: "생성됨", note: "2026-02-01 · 김회장", done: true },
        { title: "담당자 배정", note: "2026-02-03 · 이팀장", done: true },
        { title: "검토 진행", note: "2026-03-04 · 진행 중" },
        { title: "완료 예정", note: "2026-03-20" },
      ],
    };
  }
  return { layout: "list", stats: DEFAULT_STATS, table: DEFAULT_TABLE, filters: ["전체", "진행", "완료"] };
}
