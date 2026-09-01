import cors from "cors";
import express from "express";

import { env } from "./config/env.js";
import { errorHandler, notFoundHandler, requestContext } from "./middleware/error.js";
import { registerRoutes } from "./routes/index.js";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "5mb" }));
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(requestContext);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "orbitflow-backend" });
  });

  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
