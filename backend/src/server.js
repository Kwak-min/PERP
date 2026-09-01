import { createApp } from "./app.js";
import { migrate } from "./config/migrate.js";
import { env } from "./config/env.js";

migrate();

const app = createApp();
const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`orbitflow-backend listening on http://127.0.0.1:${env.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
