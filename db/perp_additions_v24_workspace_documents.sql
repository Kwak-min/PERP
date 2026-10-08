-- Additive canonical company documents. project.documents and its rows/constraints stay intact.
BEGIN;
CREATE SCHEMA IF NOT EXISTS workspace;
CREATE TABLE IF NOT EXISTS workspace.documents (
  id BIGINT PRIMARY KEY DEFAULT nextval(pg_get_serial_sequence('project.documents','id')),
  company_id BIGINT NOT NULL REFERENCES org.companies(id),
  project_id BIGINT REFERENCES project.projects(id),
  title TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  file_id BIGINT REFERENCES files.objects(id) ON DELETE SET NULL,
  author_id BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_id BIGINT NOT NULL REFERENCES auth.users(id),
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','personal','sensitive','confidential')),
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org','private','public')),
  ai_generated BOOLEAN NOT NULL DEFAULT false,
  review_status TEXT NOT NULL DEFAULT 'reviewed' CHECK (review_status IN ('reviewed','unreviewed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_documents_company ON workspace.documents(company_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS workspace_documents_project ON workspace.documents(project_id);
-- One native sequence allocates IDs for BOTH stores. Do not reset it on migration replay.
-- Explicit OVERRIDING SYSTEM VALUE inserts/sequence resets are administrative operations,
-- not part of the canonical writer contract.
CREATE OR REPLACE VIEW workspace.document_catalog AS
 SELECT d.id,p.company_id,d.project_id,p.name AS project_name,d.title,COALESCE(d.content_md,'') AS content_md,
   d.file_id,d.author_id,d.author_id AS owner_id,'internal'::text AS sensitivity,'org'::text AS visibility,
   false AS ai_generated,'reviewed'::text AS review_status,d.version,false AS archived,NULL::timestamptz AS deleted_at,
   d.created_at,d.updated_at,'project'::text AS storage
 FROM project.documents d JOIN project.projects p ON p.id=d.project_id
 UNION ALL
 SELECT d.id,d.company_id,d.project_id,p.name,d.title,d.content_md,d.file_id,d.author_id,d.owner_id,
   d.sensitivity,d.visibility,d.ai_generated,d.review_status,d.version,d.archived,d.deleted_at,d.created_at,d.updated_at,'workspace'::text
 FROM workspace.documents d LEFT JOIN project.projects p ON p.id=d.project_id AND p.company_id=d.company_id;
-- IDs reference the two-store catalog; a single-table FK cannot express that union.
CREATE TABLE IF NOT EXISTS workspace.document_versions (
 document_id BIGINT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 title TEXT NOT NULL, content TEXT NOT NULL, author_id BIGINT REFERENCES auth.users(id),
 sensitivity TEXT NOT NULL, visibility TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(document_id,revision)
);
CREATE TABLE IF NOT EXISTS workspace.document_chunks (
 document_id BIGINT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), version INTEGER NOT NULL,
 content TEXT NOT NULL, sensitivity TEXT NOT NULL, visibility TEXT NOT NULL,
 PRIMARY KEY(document_id,ordinal)
);
DO $$ BEGIN
 IF to_regprocedure('knowledge.origin_invalidation()') IS NOT NULL THEN
   EXECUTE 'CREATE OR REPLACE TRIGGER wiki_origin_invalidation AFTER UPDATE OR DELETE ON workspace.documents FOR EACH ROW EXECUTE FUNCTION knowledge.origin_invalidation()';
 END IF;
END $$;
COMMIT;
