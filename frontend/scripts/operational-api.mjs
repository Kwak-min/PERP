// 격리 QA 전용 프로세스. 데이터 경로는 부모가 만든 임시 디렉터리만 허용한다.
import { isAbsolute } from "node:path";
if (!process.env.ORBITFLOW_DATABASE_FILE || !isAbsolute(process.env.ORBITFLOW_DATABASE_FILE)) {
  throw new Error("QA requires an absolute isolated database path");
}
const [{ createApp }, { migrate }, { closeDb }] = await Promise.all([
  import("../../backend/src/app.js"),
  import("../../backend/src/config/migrate.js"),
  import("../../backend/src/config/db.js"),
]);
migrate();
const server = createApp().listen(Number(process.env.PORT ?? 0), "127.0.0.1");
server.once("error", (error) => { throw error; });
server.once("listening", () => process.send?.({ port: server.address().port }));
process.on("message", (message) => {
  if (message !== "stop") return;
  server.close((error) => {
    closeDb();
    if (error) throw error;
    process.exit(0);
  });
});
