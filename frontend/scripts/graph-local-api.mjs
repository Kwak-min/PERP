import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

// 병합 중인 앱 셸과 독립된 실제 Vault 컨트롤러/SQLite QA 서버. 원격 DB를 사용하지 않는다.
export async function startGraphApi() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitflow-graph-"));
  process.env.ORBITFLOW_DATABASE_FILE = path.join(root, "graph.db");
  process.env.ORBITFLOW_AI_PROVIDER = "echo";
  const [{migrate},{closeDb},{authRouter},{tenantsRouter},{vaultRouter},{documentsRouter},{requestContext,errorHandler}] = await Promise.all([
    import("../../backend/src/config/migrate.js"), import("../../backend/src/config/db.js"),
    import("../../backend/src/routes/auth.routes.js"), import("../../backend/src/routes/tenants.routes.js"),
    import("../../backend/src/routes/vault.routes.js"), import("../../backend/src/routes/documents.routes.js"),
    import("../../backend/src/middleware/error.js"),
  ]);
  migrate();
  const app = express();
  app.use(express.json(),requestContext);
  app.use("/api/v1/auth",authRouter); app.use("/api/v1/tenants",tenantsRouter);
  app.use("/api/v1/vault",vaultRouter); app.use("/api/v1/documents",documentsRouter);
  app.use(errorHandler);
  const server=app.listen(0,"127.0.0.1");
  await once(server,"listening",{signal:AbortSignal.timeout(10000)});
  const address=server.address(); assert.ok(address && typeof address==="object");
  return {baseUrl:`http://127.0.0.1:${address.port}/api/v1`,async close(){
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    closeDb();await rm(root,{recursive:true,force:true});
  }};
}
