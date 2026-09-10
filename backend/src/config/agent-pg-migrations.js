import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const AGENT_PG_MIGRATIONS = [
  "perp_additions_v22_inapp_agent.sql",
  "perp_additions_v23_agent_knowledge.sql",
  "perp_additions_v24_workspace_documents.sql",
];

// 기존 PG 기본 스키마와 v21 이후에 실행한다. 스키마 파일의 자체 트랜잭션을 유지한다.
export async function applyAgentPgMigrations(client) {
  for (const file of AGENT_PG_MIGRATIONS) {
    await client.query(await readFile(new URL(`../../../db/${file}`, import.meta.url), "utf8"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pgPool, closePgPool } = await import("./pg.js");
  try {
    await applyAgentPgMigrations(pgPool);
    console.log(JSON.stringify({ applied: AGENT_PG_MIGRATIONS }));
  } finally { await closePgPool(); }
}
