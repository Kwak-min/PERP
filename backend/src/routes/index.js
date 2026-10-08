import { agentRouter } from "./agent.routes.js";
import { analyticsRouter } from "./analytics.routes.js";
import { approvalsRouter } from "./approvals.routes.js";
import { assetsRouter } from "./assets.routes.js";
import { authRouter } from "./auth.routes.js";
import { automationsRouter } from "./automations.routes.js";
import { calendarRouter } from "./calendar.routes.js";
import { hrRouter } from "./hr.routes.js";
import { handoverRouter } from "./handover.routes.js";
import { importsRouter } from "./imports.routes.js";
import { integrationsRouter } from "./integrations.routes.js";
import { documentsRouter } from "./documents.routes.js";
import { financeRouter } from "./finance.routes.js";
import { membersRouter } from "./members.routes.js";
import { notificationsRouter } from './notifications.routes.js';
import { pgRouter } from "./pgAuth.routes.js";
import { projectsRouter } from "./projects.routes.js";
import { tasksRouter } from "./tasks.routes.js";
import { tenantsRouter } from "./tenants.routes.js";
import { vaultRouter } from "./vault.routes.js";
import { requireModule } from "../middleware/modules.js";
import { settingsRouter } from './settings.routes.js';

export const API_PREFIX = "/api/v1";

const REGISTRY = [
  { path: "/auth", router: authRouter, module: null },
  { path: '/settings', router: settingsRouter, module: null },
  { path: "/pg", router: pgRouter, module: null },
  { path: "/tenants", router: tenantsRouter, module: null },
  { path: "/members", router: membersRouter, module: null },
  { path: '/notifications', router: notificationsRouter, module: null },
  { path: "/projects", router: projectsRouter, module: "projects" },
  { path: "/tasks", router: tasksRouter, module: "tasks" },
  { path: "/calendar", router: calendarRouter, module: "calendar" },
  { path: "/documents", router: documentsRouter, module: "documents" },
  { path: "/handovers", router: handoverRouter, module: "handover" },
  { path: "/approvals", router: approvalsRouter, module: null },
  { path: "/finance", router: financeRouter, module: "finance" },
  { path: "/assets", router: assetsRouter, module: "assets" },
  { path: "/hr", router: hrRouter, module: null },
  { path: "/agent", router: agentRouter, module: "agent" },
  { path: "/vault", router: vaultRouter, module: "agent" },
  { path: "/automations", router: automationsRouter, module: "automations" },
  { path: "/integrations", router: integrationsRouter, module: "integrations" },
  { path: "/analytics", router: analyticsRouter, module: "analytics" },
  { path: "/imports", router: importsRouter, module: "imports" },
];

export function registerRoutes(app) {
  for (const entry of REGISTRY) {
    const middlewares = entry.module ? [requireModule(entry.module)] : [];
    app.use(`${API_PREFIX}${entry.path}`, ...middlewares, entry.router);
  }

  app.get(`${API_PREFIX}/routes`, (_req, res) => {
    res.json({
      prefix: API_PREFIX,
      groups: REGISTRY.map((entry) => ({ path: entry.path, module: entry.module })),
    });
  });
}

export { REGISTRY };
