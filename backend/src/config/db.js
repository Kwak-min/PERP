import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { env } from "./env.js";

let instance = null;

export function db() {
  if (instance) return instance;
  const file = env.databaseFile;
  if (file !== ":memory:") {
    const dir = path.dirname(path.resolve(file));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  instance = new DatabaseSync(file);
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");
  return instance;
}

export function closeDb() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function transaction(fn) {
  return (...args) => {
    const conn = db();
    conn.exec("BEGIN");
    try {
      const result = fn(...args);
      conn.exec("COMMIT");
      return result;
    } catch (error) {
      conn.exec("ROLLBACK");
      throw error;
    }
  };
}

export const query = {
  all: (sql, params = []) => db().prepare(sql).all(...params),
  get: (sql, params = []) => db().prepare(sql).get(...params) ?? null,
  run: (sql, params = []) => db().prepare(sql).run(...params),
};
