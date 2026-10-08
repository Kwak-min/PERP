export const MODULE_CATALOG = [
  {
    "key": "members",
    "label": "조직·회원·권한",
    "core": true,
    "description": "조직도, 회원 초대, 역할과 권한. 항상 켜져 있습니다."
  },
  {
    "key": "dashboard",
    "label": "대시보드",
    "core": true,
    "description": "개인·조직 현황 요약. 항상 켜져 있습니다."
  },
  {
    "key": "notifications",
    "label": "알림",
    "core": true,
    "description": "업무·승인·공지 알림. 항상 켜져 있습니다."
  },
  {
    "key": "search",
    "label": "전역 검색",
    "core": true,
    "description": "권한 범위 안에서 통합 검색. 항상 켜져 있습니다."
  },
  {
    "key": "audit",
    "label": "감사로그·보존",
    "core": true,
    "description": "행위 추적과 데이터 보존 정책. 항상 켜져 있습니다."
  },
  {
    "key": "imports",
    "label": "데이터 가져오기",
    "core": true,
    "description": "CSV 가져오기와 마이그레이션. 항상 켜져 있습니다."
  },
  {
    "key": "projects",
    "label": "프로젝트",
    "core": false,
    "description": "프로젝트, 목표, 마일스톤, 참여자."
  },
  {
    "key": "tasks",
    "label": "업무",
    "core": false,
    "description": "업무, 하위업무, 칸반, 간트, 업무량."
  },
  {
    "key": "calendar",
    "label": "캘린더",
    "core": false,
    "description": "개인·조직 일정, 행사와 참석 관리."
  },
  {
    "key": "documents",
    "label": "문서·회의록",
    "core": false,
    "description": "위키, 문서 버전 관리, 회의록과 후속업무."
  },
  {
    "key": "handover",
    "label": "인수인계",
    "core": false,
    "description": "직책 인계 패키지, 확인서. 임원 교체가 잦은 조직에 유용합니다."
  },
  {
    "key": "approvals",
    "label": "전자결재",
    "core": false,
    "description": "결재 양식, 결재선, 승인·반려. 승인 절차가 필요할 때 켜세요."
  },
  {
    "key": "finance",
    "label": "회계·재무",
    "core": false,
    "description": "수입·지출, 예산, 회비, 정산, 결산. 지원금이나 회비가 없으면 꺼도 됩니다."
  },
  {
    "key": "assets",
    "label": "자산·예약",
    "core": false,
    "description": "장비·공간 대장, 대여·반납, 예약."
  },
  {
    "key": "hr",
    "label": "인사",
    "core": false,
    "description": "구성원 인사 정보 관리. 근태·휴가는 별도 기능으로 선택합니다."
  },
  {
    "key": "agent",
    "label": "AI Agent·개인 Vault",
    "core": false,
    "description": "개인화 AI 비서, 브리핑, 기억, 개인 노트."
  },
  {
    "key": "automations",
    "label": "자동화",
    "core": false,
    "description": "트리거-조건-액션 워크플로."
  },
  {
    "key": "integrations",
    "label": "외부 연동",
    "core": false,
    "description": "캘린더, 메신저, 스토리지, 웹훅, API 키."
  },
  {
    "key": "analytics",
    "label": "분석·보고서",
    "core": false,
    "description": "KPI, 보고서, 내보내기."
  }
];

export const BY_KEY = Object.fromEntries(MODULE_CATALOG.map((m) => [m.key, m]));
export const CORE_MODULES = new Set([
  "audit",
  "dashboard",
  "imports",
  "members",
  "notifications",
  "search"
]);
export const OPTIONAL_MODULES = MODULE_CATALOG.filter((m) => !m.core).map((m) => m.key);
