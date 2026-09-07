import { Router } from "express";

import * as controller from "../controllers/agent-key.controller.js";
import { currentUser } from "../middleware/auth.js";
import { asyncRoute } from "../middleware/error.js";
import { pgIdentity, pgRoute } from "../middleware/pgAccess.js";

function scoped(handler) {
  return asyncRoute(pgRoute((req, res) => {
    const { companyId } = pgIdentity(req);
    // PG 회사 권한 검증 후에만 만든 암호화 저장 범위다. SQLite 소속/권한을 합성하지 않는다.
    req.aiKeyScope = {
      tenantId: `pg:${companyId}`,
      orgId: `pg:${companyId}`,
      userId: currentUser(req).id,
    };
    return handler(req, res);
  }, "agent.chat", "agent"));
}

export const pgAgentKeyRouter = Router();
pgAgentKeyRouter.get("/", scoped(controller.getKey));
pgAgentKeyRouter.put("/", scoped(controller.putKey));
pgAgentKeyRouter.delete("/", scoped(controller.deleteKey));
pgAgentKeyRouter.post("/test", scoped(controller.testKey));
