import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "orbitflow-startup-"));
process.env.PORT = "0";
process.env.ORBITFLOW_DATABASE_FILE = path.join(temporaryDirectory, "orbitflow.db");
process.env.ORBITFLOW_AI_PROVIDER = "echo";
process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";

let server;
let closeDb;
let closePgPool;

try {
  const [{ createApp }, migration, sqlite, postgres, routes] = await Promise.all([
    import("../backend/src/app.js"),
    import("../backend/src/config/migrate.js"),
    import("../backend/src/config/db.js"),
    import("../backend/src/config/pg.js"),
    import("../backend/src/routes/index.js"),
  ]);
  closeDb = sqlite.closeDb;
  closePgPool = postgres.closePgPool;

  const migrationResult = migration.migrate();
  server = createApp().listen(0, "127.0.0.1");
  await Promise.race([
    once(server, "listening"),
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("ERP listener startup timed out")), 5_000);
      timeout.unref();
    }),
  ]);

  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const [healthResponse, routesResponse] = await Promise.all([
    fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) }),
    fetch(`${baseUrl}/api/v1/routes`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  assert.equal(healthResponse.status, 200);
  assert.equal(routesResponse.status, 200);

  const health = await healthResponse.json();
  const catalog = await routesResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.service, "orbitflow-backend");
  assert.equal(catalog.prefix, routes.API_PREFIX);
  assert.equal(catalog.groups.length, routes.REGISTRY.length);
  assert.equal(new Set(catalog.groups.map(({ path: routePath }) => routePath)).size, catalog.groups.length);

  console.log(`ERP_SQLITE_MIGRATION tables=${migrationResult.tables} indexes=${migrationResult.indexes}`);
  console.log(`ERP_LIVENESS status=${health.status} service=${health.service}`);
  console.log(`ERP_ROUTE_CATALOG prefix=${catalog.prefix} groups=${catalog.groups.length}`);
  console.log("RESULT PASS (isolated ERP startup; external PostgreSQL not contacted)");
} finally {
  if (server?.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  closeDb?.();
  await closePgPool?.();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
