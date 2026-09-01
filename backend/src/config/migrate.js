import { db, transaction } from "./db.js";
import { INDEXES, TABLES } from "./schema.js";

export function migrate() {
  const conn = db();
  const run = transaction(() => {
    for (const statement of TABLES) conn.exec(statement);
    for (const statement of INDEXES) conn.exec(statement);
  });
  run();
  return { tables: TABLES.length, indexes: INDEXES.length };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const result = migrate();
  console.log(`migrated: ${result.tables} tables, ${result.indexes} indexes`);
}
