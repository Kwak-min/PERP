import { allRoutePaths } from "../src/routes/catalog.ts";

const expected = [
  "/",
  "/admin",
  "/admin/ai-policy",
  "/admin/audit",
  "/admin/billing",
  "/admin/data",
  "/agent",
  "/agent/actions/:actionId",
  "/agent/brief",
  "/agent/memory",
  "/agent/templates",
  "/analytics",
  "/approvals",
  "/assets",
  "/assets/:assetId",
  "/assets/reservations",
  "/automations/:workflowId/edit",
  "/automations/runs",
  "/calendar",
  "/calendar/:eventId",
  "/change-password",
  "/dashboard/org",
  "/documents",
  "/documents/:documentId",
  "/documents/graph",
  "/documents/meetings/:meetingId",
  "/finance",
  "/finance/budgets",
  "/finance/close",
  "/finance/dues",
  "/finance/settlements",
  "/finance/transactions",
  "/handover",
  "/hr/attendance",
  "/hr/leave",
  "/hr/members/:memberId",
  "/invitations",
  "/login",
  "/members",
  "/notifications",
  "/onboarding/organization",
  "/org-chart",
  "/org-log",
  "/projects",
  "/projects/:projectId",
  "/projects/:projectId/board",
  "/projects/:projectId/timeline",
  "/reserve",
  '/settings',
  "/settings/ai-key",
  "/settings/approval-forms",
  "/settings/branches",
  "/settings/integrations",
  "/settings/organization",
  "/settings/roles",
  "/signup",
  "/tasks",
  "/tasks/:taskId",
  "/vault",
  "/vault/graph",
  "/welcome",
  "/workload",
];

const actual = new Set(allRoutePaths);
const missing = expected.filter((path) => !actual.has(path));
const unexpected = allRoutePaths.filter((path) => !expected.includes(path));
const duplicates = allRoutePaths.filter(
  (path, index) => allRoutePaths.indexOf(path) !== index,
);

console.log(`EXPECTED ${expected.length}`);
console.log(`ACTUAL ${allRoutePaths.length}`);
console.log(`MISSING ${missing.length}${missing.length ? `: ${missing.join(", ")}` : ""}`);
console.log(`UNEXPECTED ${unexpected.length}${unexpected.length ? `: ${unexpected.join(", ")}` : ""}`);
console.log(`DUPLICATES ${duplicates.length}${duplicates.length ? `: ${duplicates.join(", ")}` : ""}`);

if (missing.length || unexpected.length || duplicates.length) process.exitCode = 1;
