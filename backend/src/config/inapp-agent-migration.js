// 실행 영수증은 기존 agent_action과 별도의 수명주기를 갖는다.
export function migrateInappAgent(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, org_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, conversation_id TEXT, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
      response_json TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(tenant_id,org_id,actor_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS agent_operations (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      tool TEXT NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('preview','confirmed','executed','cancelled','failed')),
      version INTEGER NOT NULL DEFAULT 1, approval_id TEXT REFERENCES approval(id),
      execution_key TEXT, execution_version INTEGER, result_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(tenant_id,org_id,actor_id,run_id,tool_call_id)
    );
  `);
  for (const table of ['agent_runs', 'agent_operations']) {
    if (!conn.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'knowledge_mode')) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN knowledge_mode TEXT NOT NULL DEFAULT 'personal' CHECK(knowledge_mode IN ('personal','company'))`);
    }
    conn.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_mode_immutable BEFORE UPDATE OF knowledge_mode ON ${table}
      WHEN OLD.knowledge_mode IS NOT NEW.knowledge_mode BEGIN SELECT RAISE(ABORT,'agent knowledge mode is immutable'); END;`);
  }
}
