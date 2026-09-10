-- Native PostgreSQL knowledge lane; canonical notes/documents remain in notes/project.
BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_knowledge_attachment (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 knowledge_mode TEXT NOT NULL CHECK(knowledge_mode IN ('personal','company')),
 filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0 AND size<=1000000),
 content_base64 TEXT NOT NULL, extracted_text TEXT NOT NULL, content_hash TEXT NOT NULL,
 classification TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_knowledge_attachment_scope ON public.agent_knowledge_attachment(tenant_id,workspace_id,actor_id,knowledge_mode);
CREATE TABLE IF NOT EXISTS public.agent_knowledge_receipt (
 tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 knowledge_mode TEXT NOT NULL CHECK(knowledge_mode IN ('personal','company')), run_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,actor_id,knowledge_mode,run_id)
);
CREATE TABLE IF NOT EXISTS public.agent_knowledge_note_metadata (
 source_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 knowledge_mode TEXT NOT NULL CHECK(knowledge_mode IN ('personal','company')),
 classification TEXT NOT NULL, provenance_json TEXT NOT NULL, content_hash TEXT NOT NULL,
 review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_status='unreviewed'), created_at TEXT NOT NULL
);
COMMIT;
