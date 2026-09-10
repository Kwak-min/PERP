export const AGENT_KNOWLEDGE_DDL = [
  `CREATE TABLE IF NOT EXISTS agent_knowledge_attachment (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    knowledge_mode TEXT NOT NULL CHECK(knowledge_mode IN ('personal','company')),
    filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0 AND size<=1000000),
    content_base64 TEXT NOT NULL, extracted_text TEXT NOT NULL, content_hash TEXT NOT NULL,
    classification TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS agent_knowledge_attachment_scope ON agent_knowledge_attachment(tenant_id,workspace_id,actor_id,knowledge_mode)`,
  `CREATE TABLE IF NOT EXISTS agent_knowledge_receipt (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    knowledge_mode TEXT NOT NULL CHECK(knowledge_mode IN ('personal','company')), run_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(tenant_id,workspace_id,actor_id,knowledge_mode,run_id))`,
  `CREATE TABLE IF NOT EXISTS agent_knowledge_note_metadata (
    source_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    knowledge_mode TEXT NOT NULL CHECK(knowledge_mode IN ('personal','company')),
    classification TEXT NOT NULL, provenance_json TEXT NOT NULL, content_hash TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_status='unreviewed'), created_at TEXT NOT NULL)`,
];

export function migrateAgentKnowledge(database) {
  for (const sql of AGENT_KNOWLEDGE_DDL) database.exec(sql);
  const columns = database.prepare('PRAGMA table_info(ai_conversation)').all();
  if (columns.length && !columns.some(row => row.name === 'knowledge_mode')) {
    database.exec("ALTER TABLE ai_conversation ADD COLUMN knowledge_mode TEXT NOT NULL DEFAULT 'personal' CHECK(knowledge_mode IN ('personal','company'))");
  }
  if (columns.length) database.exec(`CREATE TRIGGER IF NOT EXISTS ai_conversation_knowledge_mode_immutable
    BEFORE UPDATE OF knowledge_mode ON ai_conversation WHEN NEW.knowledge_mode<>OLD.knowledge_mode
    BEGIN SELECT RAISE(ABORT,'immutable knowledge mode'); END`);
}
