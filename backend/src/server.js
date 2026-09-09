import { createApp } from "./app.js";
import { migrate } from "./config/migrate.js";
import { env } from "./config/env.js";
import { readImportCleanupConfig, startImportCleanup } from "./services/expense-import-maintenance.js";

const cleanupConfig = readImportCleanupConfig();
migrate();

const app = createApp();
let importCleanup, shuttingDown = false;
export const server = app.listen(env.port, "127.0.0.1", () => {
  importCleanup = startImportCleanup(cleanupConfig);
  console.log(`orbitflow-backend listening on http://127.0.0.1:${server.address().port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const stopped = importCleanup?.stop();
    server.close(async () => {
      await stopped;
      process.exit(0);
    });
  });
}
// 다른 시작 작업은 그대로 두고, 추후 Wiki worker도 기존 종료 경로에서 별도로 stop한다.
server.once("close", () => { void importCleanup?.stop(); });
