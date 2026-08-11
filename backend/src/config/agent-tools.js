export const TOOLS = Object.fromEntries([
  {
    "name": "search.documents",
    "stage": "read",
    "resource": "document",
    "permission": "document.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "search.tasks",
    "stage": "read",
    "resource": "task",
    "permission": "task.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "search.events",
    "stage": "read",
    "resource": "event",
    "permission": "event.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "search.transactions",
    "stage": "read",
    "resource": "transaction",
    "permission": "transaction.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "search.members",
    "stage": "read",
    "resource": "membership",
    "permission": "member.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "search.meetings",
    "stage": "read",
    "resource": "meeting",
    "permission": "document.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "get.brief",
    "stage": "read",
    "resource": "dashboard",
    "permission": "agent.chat",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "analyze.budget_risk",
    "stage": "read",
    "resource": "budget",
    "permission": "budget.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "analyze.overdue_tasks",
    "stage": "read",
    "resource": "task",
    "permission": "task.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "analyze.anomaly_transaction",
    "stage": "read",
    "resource": "transaction",
    "permission": "transaction.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "recommend.assignee",
    "stage": "recommend",
    "resource": "task",
    "permission": "task.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "recommend.account_code",
    "stage": "recommend",
    "resource": "transaction",
    "permission": "transaction.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "recommend.budget_line",
    "stage": "recommend",
    "resource": "budget",
    "permission": "budget.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "recommend.schedule_slot",
    "stage": "recommend",
    "resource": "event",
    "permission": "event.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "draft.document",
    "stage": "draft",
    "resource": "document",
    "permission": "document.write",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "document version"
  },
  {
    "name": "draft.notice",
    "stage": "draft",
    "resource": "document",
    "permission": "document.write",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "document version"
  },
  {
    "name": "draft.meeting_minutes",
    "stage": "draft",
    "resource": "meeting",
    "permission": "meeting.write",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "document version"
  },
  {
    "name": "draft.handover_package",
    "stage": "draft",
    "resource": "handover_package",
    "permission": "handover.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "package delete"
  },
  {
    "name": "draft.report",
    "stage": "draft",
    "resource": "analytics",
    "permission": "analytics.read",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "draft.settlement",
    "stage": "draft",
    "resource": "settlement",
    "permission": "settlement.create",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "draft discard"
  },
  {
    "name": "draft.approval_request",
    "stage": "draft",
    "resource": "approval",
    "permission": "approval.request",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "withdraw"
  },
  {
    "name": "extract.receipt_ocr",
    "stage": "draft",
    "resource": "file_object",
    "permission": "settlement.create",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "create.task",
    "stage": "execute",
    "resource": "task",
    "permission": "task.write",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "soft delete"
  },
  {
    "name": "update.task_status",
    "stage": "execute",
    "resource": "task",
    "permission": "task.write",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "previous status"
  },
  {
    "name": "create.event",
    "stage": "execute",
    "resource": "event",
    "permission": "event.write",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "soft delete"
  },
  {
    "name": "create.document",
    "stage": "execute",
    "resource": "document",
    "permission": "document.write",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "soft delete"
  },
  {
    "name": "submit.approval",
    "stage": "execute",
    "resource": "approval",
    "permission": "approval.request",
    "requires_approval": false,
    "requires_reauth": false,
    "rollback": "withdraw"
  },
  {
    "name": "send.notification",
    "stage": "execute",
    "resource": "notification",
    "permission": "notification.read",
    "requires_approval": true,
    "requires_reauth": false,
    "rollback": ""
  },
  {
    "name": "confirm.transaction",
    "stage": "execute",
    "resource": "transaction",
    "permission": "transaction.confirm",
    "requires_approval": true,
    "requires_reauth": true,
    "rollback": "previous status"
  },
  {
    "name": "update.budget",
    "stage": "execute",
    "resource": "budget",
    "permission": "budget.write",
    "requires_approval": true,
    "requires_reauth": false,
    "rollback": "previous revision"
  },
  {
    "name": "change.member_status",
    "stage": "execute",
    "resource": "membership",
    "permission": "member.write",
    "requires_approval": true,
    "requires_reauth": true,
    "rollback": "previous status"
  },
  {
    "name": "change.permission",
    "stage": "execute",
    "resource": "membership",
    "permission": "role.assign",
    "requires_approval": true,
    "requires_reauth": true,
    "rollback": "previous roles"
  },
  {
    "name": "delete.task",
    "stage": "execute",
    "resource": "task",
    "permission": "task.write",
    "requires_approval": true,
    "requires_reauth": true,
    "rollback": "restore soft delete"
  },
  {
    "name": "delete.document",
    "stage": "execute",
    "resource": "document",
    "permission": "document.write",
    "requires_approval": true,
    "requires_reauth": true,
    "rollback": "restore soft delete"
  }
].map((t) => [t.name, t]));

export const PRESETS = {
  "chair": {
    "label": "회장·대표 Agent",
    "tools": [
      "search.documents",
      "search.tasks",
      "search.events",
      "search.transactions",
      "analyze.budget_risk",
      "analyze.overdue_tasks",
      "draft.report",
      "get.brief"
    ],
    "brief": [
      "조직 현황",
      "지연 업무",
      "승인 대기",
      "예산 위험",
      "행사 준비상황",
      "이번 주 우선순위"
    ]
  },
  "treasurer": {
    "label": "총무·회계 Agent",
    "tools": [
      "search.transactions",
      "analyze.anomaly_transaction",
      "recommend.account_code",
      "recommend.budget_line",
      "extract.receipt_ocr",
      "draft.settlement",
      "get.brief"
    ],
    "brief": [
      "회비 미납",
      "지출 누락",
      "미증빙 거래",
      "예산 초과",
      "결산 초안"
    ]
  },
  "dept_lead": {
    "label": "부서장 Agent",
    "tools": [
      "search.tasks",
      "analyze.overdue_tasks",
      "recommend.assignee",
      "create.task",
      "get.brief"
    ],
    "brief": [
      "부서 업무",
      "부서원 업무량",
      "지연 업무",
      "담당자 재배정",
      "부서 보고서"
    ]
  },
  "member": {
    "label": "일반 회원 Agent",
    "tools": [
      "search.tasks",
      "search.events",
      "search.documents",
      "get.brief",
      "create.task"
    ],
    "brief": [
      "나의 오늘 일정",
      "나의 업무",
      "마감 임박 업무",
      "공지 요약"
    ]
  },
  "successor": {
    "label": "신임 임원 Agent",
    "tools": [
      "search.meetings",
      "search.documents",
      "search.tasks",
      "draft.handover_package",
      "get.brief"
    ],
    "brief": [
      "전임 업무",
      "반복 일정",
      "과거 회의",
      "핵심 문서",
      "업무 시작 순서",
      "주의사항"
    ]
  }
};

export function presetFor(roles) {
  for (const role of ["chair", "owner", "org_admin"]) if (roles.includes(role)) return "chair";
  if (roles.includes("treasurer")) return "treasurer";
  if (roles.includes("dept_lead") || roles.includes("pm")) return "dept_lead";
  return "member";
}
