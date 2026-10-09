import { createApp } from "./app.js";
import { env } from "./config/env.js";

// perp_db 전용 전환: 부팅 시 SQLite 스키마를 만들지 않는다(migrate() 제거).
// 모든 런타임 데이터는 perp_db(PostgreSQL)를 사용한다.

const app = createApp();
const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`orbitflow-backend listening on http://127.0.0.1:${env.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
