import cors from "cors";
import express from "express";

import { env } from "./config/env.js";
import { errorHandler, notFoundHandler, requestContext } from "./middleware/error.js";
import { pgAuthBridge } from "./middleware/pgAuth.js";
import { registerRoutes } from "./routes/index.js";
import { knowledgeTransportError } from "./controllers/agent-knowledge.controller.js";

export function createApp() {
  const app = express();

  // Keep only transport presence, never a second raw JSON copy. Empty JSON is otherwise parsed as {}.
  app.use(express.json({ limit: "5mb", verify: (req, _res, bytes) => { req.hasJsonBody = bytes.length > 0; } }));
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      exposedHeaders: ["X-Request-Id", "Content-Disposition"],
    }),
  );
  app.use(requestContext);
  // perp_db 세션 토큰을 라우트 앞단에서 해석해 레거시 인증과 호환시킨다.
  app.use(pgAuthBridge);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "orbitflow-backend" });
  });

  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(knowledgeTransportError);
  app.use(errorHandler);
  return app;
}
