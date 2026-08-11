export const ROLE_TEMPLATES = {
  "owner": {
    "label": "조직 소유자",
    "scope": "all",
    "permissions": [
      "*"
    ]
  },
  "org_admin": {
    "label": "조직 관리자",
    "scope": "all",
    "permissions": [
      "agent.chat",
      "agent.policy.manage",
      "analytics.read",
      "approval.decide",
      "approval.form.manage",
      "approval.request",
      "asset.read",
      "asset.write",
      "attendance.read",
      "audit.read",
      "automation.manage",
      "budget.read",
      "department.write",
      "document.read",
      "document.write",
      "dues.read",
      "event.read",
      "event.write",
      "handover.confirm",
      "handover.read",
      "integration.manage",
      "leave.approve",
      "meeting.write",
      "member.read",
      "member.write",
      "notification.read",
      "organization.settings",
      "project.read",
      "project.write",
      "recruitment.manage",
      "reservation.create",
      "retention.manage",
      "role.assign",
      "settlement.create",
      "task.read",
      "task.write",
      "transaction.read"
    ]
  },
  "chair": {
    "label": "대표/회장",
    "scope": "all",
    "permissions": [
      "agent.chat",
      "analytics.read",
      "approval.decide",
      "approval.request",
      "asset.read",
      "attendance.read",
      "audit.read",
      "budget.read",
      "budget.write",
      "document.read",
      "document.write",
      "dues.read",
      "event.read",
      "event.write",
      "fiscal.reopen.approve",
      "handover.read",
      "leave.approve",
      "meeting.write",
      "member.read",
      "notification.read",
      "project.read",
      "project.write",
      "recruitment.manage",
      "settlement.create",
      "task.read",
      "task.write",
      "transaction.read"
    ]
  },
  "dept_lead": {
    "label": "부서장/팀장",
    "scope": "department",
    "permissions": [
      "agent.chat",
      "analytics.read",
      "approval.decide",
      "approval.request",
      "asset.read",
      "asset.write",
      "attendance.read",
      "automation.manage",
      "budget.read",
      "department.write",
      "document.read",
      "document.write",
      "event.read",
      "event.write",
      "handover.confirm",
      "handover.read",
      "leave.approve",
      "meeting.write",
      "member.read",
      "member.write",
      "notification.read",
      "project.read",
      "project.write",
      "reservation.create",
      "settlement.create",
      "task.read",
      "task.write"
    ]
  },
  "treasurer": {
    "label": "총무/회계",
    "scope": "all",
    "permissions": [
      "agent.chat",
      "analytics.read",
      "approval.decide",
      "approval.request",
      "budget.read",
      "budget.write",
      "document.read",
      "dues.read",
      "dues.write",
      "event.read",
      "fiscal.close",
      "fiscal.reopen.request",
      "member.read",
      "notification.read",
      "project.read",
      "settlement.create",
      "task.read",
      "transaction.confirm",
      "transaction.read",
      "transaction.write"
    ]
  },
  "hr": {
    "label": "인사 담당자",
    "scope": "all",
    "permissions": [
      "agent.chat",
      "analytics.read",
      "approval.decide",
      "approval.request",
      "attendance.read",
      "attendance.write",
      "document.read",
      "event.read",
      "handover.confirm",
      "handover.read",
      "leave.approve",
      "member.read",
      "member.write",
      "notification.read",
      "project.read",
      "recruitment.manage",
      "task.read"
    ]
  },
  "pm": {
    "label": "프로젝트 관리자",
    "scope": "project",
    "permissions": [
      "agent.chat",
      "analytics.read",
      "approval.request",
      "asset.read",
      "budget.read",
      "document.read",
      "document.write",
      "event.read",
      "event.write",
      "meeting.write",
      "member.read",
      "notification.read",
      "project.read",
      "project.write",
      "reservation.create",
      "settlement.create",
      "task.read",
      "task.write"
    ]
  },
  "member": {
    "label": "일반 구성원",
    "scope": "self",
    "permissions": [
      "agent.chat",
      "approval.request",
      "asset.read",
      "document.read",
      "dues.read",
      "event.read",
      "event.write",
      "handover.read",
      "meeting.write",
      "member.read",
      "notification.read",
      "project.read",
      "reservation.create",
      "settlement.create",
      "task.read",
      "task.write"
    ]
  },
  "guest": {
    "label": "외부 협력자",
    "scope": "project",
    "permissions": [
      "document.read",
      "event.read",
      "project.read",
      "task.read"
    ]
  },
  "auditor": {
    "label": "감사자/열람자",
    "scope": "all",
    "permissions": [
      "analytics.read",
      "asset.read",
      "attendance.read",
      "audit.export",
      "audit.read",
      "budget.read",
      "document.read",
      "dues.read",
      "event.read",
      "handover.read",
      "member.read",
      "notification.read",
      "project.read",
      "task.read",
      "transaction.read"
    ]
  },
  "platform_admin": {
    "label": "플랫폼 최고관리자",
    "scope": "all",
    "permissions": [
      "platform.incidents",
      "platform.plans",
      "platform.tenants"
    ]
  }
};

export const MASKED_FIELDS = {
  "phone": "member.write",
  "address": "member.write",
  "birth_date": "member.write",
  "emergency_contact": "attendance.write"
};

export const SCOPE_ORDER = ["self", "project", "department", "all"];

export function permissionsFor(roles) {
  const out = new Set();
  for (const role of roles) {
    for (const permission of ROLE_TEMPLATES[role]?.permissions ?? []) out.add(permission);
  }
  return out;
}

export function widestScope(roles) {
  let best = "self";
  for (const role of roles) {
    const scope = ROLE_TEMPLATES[role]?.scope ?? "self";
    if (SCOPE_ORDER.indexOf(scope) > SCOPE_ORDER.indexOf(best)) best = scope;
  }
  return best;
}
