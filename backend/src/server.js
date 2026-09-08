import { createApp } from "./app.js";
import { migrate } from "./config/migrate.js";
import { env } from "./config/env.js";
import { startWikiWorker } from './services/knowledge-wiki-worker.service.js';

migrate();

const worker = startWikiWorker();
const app = createApp();
const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`orbitflow-backend listening on http://127.0.0.1:${env.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      try { await worker.stop(); process.exit(0); }
      catch (error) { console.error('[wiki-worker] shutdown failed',error.code ?? 'INTERNAL'); process.exit(1); }
    });
  });
}
