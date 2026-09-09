import { createApp } from "./app.js";
import { migrate } from "./config/migrate.js";
import { env } from "./config/env.js";
import { closeDb } from "./config/db.js";
import { closePgPool } from "./config/pg.js";
import { configuredWikiModel, startWikiWorker } from './services/knowledge-wiki-worker.service.js';
import { readImportCleanupConfig, startImportCleanup } from "./services/expense-import-maintenance.js";

const cleanupConfig = readImportCleanupConfig();
configuredWikiModel();
migrate();

const app = createApp();
let worker, importCleanup, shuttingDown = false;
export const server = app.listen(env.port, "127.0.0.1", error => {
  // Express 5 also calls this on bind failure; the error listener below owns it.
  if (error) return;
  if (shuttingDown) { server.close(); return; }
  try {
    worker = startWikiWorker();
    importCleanup = startImportCleanup(cleanupConfig);
    console.log(`orbitflow-backend listening on http://127.0.0.1:${server.address().port}`);
  } catch (error) { shutdown(error); }
});

function reportFailure(error) {
  console.error('[runtime] shutdown failed', error.code ?? 'INTERNAL');
  process.exitCode = 1;
}

function shutdown(error) {
  if (error) reportFailure(error);
  if (shuttingDown) return;
  shuttingDown = true;
  // Invoke both stops immediately, even if either throws. HTTP may still be draining.
  const draining = Promise.allSettled([
    (async () => { await worker?.stop(); })(),
    (async () => { await importCleanup?.stop(); })(),
    new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    }),
  ]);
  void (async () => {
    for (const result of await draining) if (result.status === 'rejected') reportFailure(result.reason);
    // Workers and in-flight HTTP retain their databases until ALL have settled.
    const closed = await Promise.allSettled([
      (async () => { closeDb(); })(),
      (async () => { await closePgPool(); })(),
    ]);
    for (const result of closed) if (result.status === 'rejected') reportFailure(result.reason);
    // Natural exit makes leaked threads/timers visible instead of hiding them with exit().
  })();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown());
server.once("error", shutdown);
server.once("close", () => shutdown());
