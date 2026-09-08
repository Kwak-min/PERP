CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE TABLE knowledge.wiki (id TEXT PRIMARY KEY, store TEXT NOT NULL CHECK(store IN ('legacy','pg')), scope TEXT NOT NULL CHECK(scope IN ('personal','company')),
    tenant_id TEXT, company_id TEXT, owner_id TEXT, generation INTEGER NOT NULL DEFAULT 1,
    active_schema_id TEXT, created_at TEXT NOT NULL,
    CHECK(tenant_id IS NULL OR length(tenant_id)>0), CHECK(company_id IS NULL OR length(company_id)>0), CHECK(owner_id IS NULL OR length(owner_id)>0),
    CHECK((store='pg' AND tenant_id IS NULL AND ((scope='personal' AND company_id IS NULL AND owner_id IS NOT NULL) OR (scope='company' AND company_id IS NOT NULL AND owner_id IS NULL))) OR
      (store='legacy' AND tenant_id IS NOT NULL AND company_id IS NOT NULL AND ((scope='personal' AND owner_id IS NOT NULL) OR (scope='company' AND owner_id IS NULL)))));
CREATE TABLE knowledge.schema_revision (wiki_id TEXT NOT NULL, id TEXT NOT NULL, rules_md TEXT NOT NULL, rules_sha256 TEXT NOT NULL, compiler_version TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.source (wiki_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('record','upload')), origin_kind TEXT, origin_id TEXT,
    current_revision_id TEXT, access_version INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
    registered_by TEXT NOT NULL, withdrawn_at TEXT, created_at TEXT NOT NULL,
    CHECK((kind='record' AND origin_kind IS NOT NULL AND origin_kind IN ('note','document') AND origin_id IS NOT NULL AND length(origin_id)>0) OR (kind='upload' AND origin_kind IS NULL AND origin_id IS NULL)), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.source_revision (wiki_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, extraction_revision_id TEXT NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL, original_base64 TEXT NOT NULL, original_sha256 TEXT NOT NULL,
    content_sha256 TEXT NOT NULL, origin_version TEXT, restrictions_json TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(wiki_id,source_id,id), UNIQUE(wiki_id,extraction_revision_id), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.page (wiki_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('page','entity','concept')), published_head_id TEXT,
    version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'withdrawn' CHECK(state IN ('published','withdrawn')), created_at TEXT NOT NULL, PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.page_revision (wiki_id TEXT NOT NULL, id TEXT NOT NULL, page_id TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, index_entry TEXT NOT NULL,
    content_sha256 TEXT NOT NULL, citations_json TEXT NOT NULL, links_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
    input_manifest_hash TEXT NOT NULL, schema_revision_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(wiki_id,page_id,id), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.job (wiki_id TEXT NOT NULL, id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('ingest','query','lint')), request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
    actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','unavailable')),
    fence INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until TEXT, current_attempt_id TEXT, input_manifest_hash TEXT,
    source_vector_json TEXT NOT NULL, target_vector_json TEXT NOT NULL, schema_revision_id TEXT NOT NULL,
    config_version TEXT NOT NULL, model_version TEXT, result_json TEXT, result_hash TEXT, failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(wiki_id,actor_id,idempotency_key), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.job_attempt (wiki_id TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3), fence INTEGER NOT NULL,
    lease_owner TEXT NOT NULL, model_version TEXT NOT NULL, config_json TEXT NOT NULL, input_manifest_hash TEXT NOT NULL,
    result_hash TEXT, started_at TEXT NOT NULL, finished_at TEXT, failure_code TEXT,
    UNIQUE(wiki_id,job_id,ordinal), UNIQUE(wiki_id,job_id,id), UNIQUE(wiki_id,job_id,fence), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.job_input (wiki_id TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    kind TEXT NOT NULL CHECK(kind IN ('source_revision','page_revision','catalog','question','instruction','schema_revision','prior_result')),
    source_revision_id TEXT, page_revision_id TEXT, schema_revision_id TEXT, supplied_text TEXT NOT NULL, supplied_sha256 TEXT NOT NULL,
    authorization_json TEXT NOT NULL, classification TEXT NOT NULL, raw_closure_json TEXT NOT NULL, input_json TEXT NOT NULL,
    UNIQUE(wiki_id,attempt_id,ordinal),
    CHECK((kind='source_revision' AND source_revision_id IS NOT NULL AND page_revision_id IS NULL AND schema_revision_id IS NULL) OR
      (kind='page_revision' AND page_revision_id IS NOT NULL AND source_revision_id IS NULL AND schema_revision_id IS NULL) OR
      (kind='schema_revision' AND schema_revision_id IS NOT NULL AND source_revision_id IS NULL AND page_revision_id IS NULL) OR
      (kind IN ('catalog','question','instruction','prior_result') AND source_revision_id IS NULL AND page_revision_id IS NULL AND schema_revision_id IS NULL)), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.dependency (wiki_id TEXT NOT NULL, id TEXT NOT NULL, dependent_page_revision_id TEXT, dependent_job_id TEXT, dependent_change_set_id TEXT,
    source_revision_id TEXT, page_revision_id TEXT, relation TEXT NOT NULL CHECK(relation IN ('direct','transitive')),
    CHECK((CASE WHEN dependent_page_revision_id IS NULL THEN 0 ELSE 1 END + CASE WHEN dependent_job_id IS NULL THEN 0 ELSE 1 END + CASE WHEN dependent_change_set_id IS NULL THEN 0 ELSE 1 END)=1),
    CHECK((CASE WHEN source_revision_id IS NULL THEN 0 ELSE 1 END + CASE WHEN page_revision_id IS NULL THEN 0 ELSE 1 END)=1), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.change_set (wiki_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL, job_id TEXT, state TEXT NOT NULL CHECK(state IN ('draft','published','rejected')),
    proposed_revisions_json TEXT NOT NULL, expected_heads_json TEXT NOT NULL, lineage_json TEXT NOT NULL,
    schema_revision_id TEXT NOT NULL, input_manifest_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.publication (wiki_id TEXT NOT NULL, id TEXT NOT NULL, change_set_id TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    manifest_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(wiki_id,idempotency_key), UNIQUE(wiki_id,change_set_id), PRIMARY KEY(wiki_id,id));
CREATE TABLE knowledge.event (wiki_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT NOT NULL, page_revision_id TEXT, source_revision_id TEXT,
    job_id TEXT, change_set_id TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(wiki_id,sequence), PRIMARY KEY(wiki_id,id));
ALTER TABLE knowledge.schema_revision ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.source ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.source_revision ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.page ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.page_revision ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job_attempt ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job_input ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.dependency ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.change_set ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.publication ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.event ADD FOREIGN KEY(wiki_id) REFERENCES knowledge.wiki(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.wiki ADD FOREIGN KEY(id,active_schema_id) REFERENCES knowledge.schema_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.source ADD FOREIGN KEY(wiki_id,id,current_revision_id) REFERENCES knowledge.source_revision(wiki_id,source_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.source_revision ADD FOREIGN KEY(wiki_id,source_id) REFERENCES knowledge.source(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.page ADD FOREIGN KEY(wiki_id,id,published_head_id) REFERENCES knowledge.page_revision(wiki_id,page_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.page_revision ADD FOREIGN KEY(wiki_id,page_id) REFERENCES knowledge.page(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.page_revision ADD FOREIGN KEY(wiki_id,schema_revision_id) REFERENCES knowledge.schema_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job ADD FOREIGN KEY(wiki_id,schema_revision_id) REFERENCES knowledge.schema_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job ADD FOREIGN KEY(wiki_id,id,current_attempt_id) REFERENCES knowledge.job_attempt(wiki_id,job_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job_attempt ADD FOREIGN KEY(wiki_id,job_id) REFERENCES knowledge.job(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job_input ADD FOREIGN KEY(wiki_id,job_id,attempt_id) REFERENCES knowledge.job_attempt(wiki_id,job_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job_input ADD FOREIGN KEY(wiki_id,source_revision_id) REFERENCES knowledge.source_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job_input ADD FOREIGN KEY(wiki_id,page_revision_id) REFERENCES knowledge.page_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.job_input ADD FOREIGN KEY(wiki_id,schema_revision_id) REFERENCES knowledge.schema_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.dependency ADD FOREIGN KEY(wiki_id,dependent_page_revision_id) REFERENCES knowledge.page_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.dependency ADD FOREIGN KEY(wiki_id,dependent_job_id) REFERENCES knowledge.job(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.dependency ADD FOREIGN KEY(wiki_id,dependent_change_set_id) REFERENCES knowledge.change_set(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.dependency ADD FOREIGN KEY(wiki_id,source_revision_id) REFERENCES knowledge.source_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.dependency ADD FOREIGN KEY(wiki_id,page_revision_id) REFERENCES knowledge.page_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.change_set ADD FOREIGN KEY(wiki_id,job_id) REFERENCES knowledge.job(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.change_set ADD FOREIGN KEY(wiki_id,schema_revision_id) REFERENCES knowledge.schema_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.publication ADD FOREIGN KEY(wiki_id,change_set_id) REFERENCES knowledge.change_set(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.event ADD FOREIGN KEY(wiki_id,page_revision_id) REFERENCES knowledge.page_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.event ADD FOREIGN KEY(wiki_id,source_revision_id) REFERENCES knowledge.source_revision(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.event ADD FOREIGN KEY(wiki_id,job_id) REFERENCES knowledge.job(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge.event ADD FOREIGN KEY(wiki_id,change_set_id) REFERENCES knowledge.change_set(wiki_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX knowledge_wiki_scope ON knowledge.wiki(store,scope,COALESCE(tenant_id,''),COALESCE(company_id,''),COALESCE(owner_id,''));
CREATE UNIQUE INDEX knowledge_source_origin ON knowledge.source(wiki_id,origin_kind,origin_id) WHERE kind='record';
CREATE FUNCTION knowledge.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'knowledge immutable row'; END $$;
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON knowledge.source_revision FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON knowledge.page_revision FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON knowledge.schema_revision FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON knowledge.job_input FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON knowledge.dependency FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON knowledge.publication FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON knowledge.event FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_fields BEFORE UPDATE ON knowledge.wiki FOR EACH ROW WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.store IS DISTINCT FROM NEW.store OR OLD.scope IS DISTINCT FROM NEW.scope OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.company_id IS DISTINCT FROM NEW.company_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_delete BEFORE DELETE ON knowledge.wiki FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_fields BEFORE UPDATE ON knowledge.source FOR EACH ROW WHEN (OLD.wiki_id IS DISTINCT FROM NEW.wiki_id OR OLD.id IS DISTINCT FROM NEW.id OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.origin_kind IS DISTINCT FROM NEW.origin_kind OR OLD.origin_id IS DISTINCT FROM NEW.origin_id OR OLD.registered_by IS DISTINCT FROM NEW.registered_by OR OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_delete BEFORE DELETE ON knowledge.source FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_fields BEFORE UPDATE ON knowledge.page FOR EACH ROW WHEN (OLD.wiki_id IS DISTINCT FROM NEW.wiki_id OR OLD.id IS DISTINCT FROM NEW.id OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_delete BEFORE DELETE ON knowledge.page FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_fields BEFORE UPDATE ON knowledge.job FOR EACH ROW WHEN (OLD.wiki_id IS DISTINCT FROM NEW.wiki_id OR OLD.id IS DISTINCT FROM NEW.id OR OLD.operation IS DISTINCT FROM NEW.operation OR OLD.request_json IS DISTINCT FROM NEW.request_json OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.actor_id IS DISTINCT FROM NEW.actor_id OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.source_vector_json IS DISTINCT FROM NEW.source_vector_json OR OLD.target_vector_json IS DISTINCT FROM NEW.target_vector_json OR OLD.schema_revision_id IS DISTINCT FROM NEW.schema_revision_id OR OLD.config_version IS DISTINCT FROM NEW.config_version OR OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_delete BEFORE DELETE ON knowledge.job FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_fields BEFORE UPDATE ON knowledge.job_attempt FOR EACH ROW WHEN (OLD.wiki_id IS DISTINCT FROM NEW.wiki_id OR OLD.id IS DISTINCT FROM NEW.id OR OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.ordinal IS DISTINCT FROM NEW.ordinal OR OLD.fence IS DISTINCT FROM NEW.fence OR OLD.lease_owner IS DISTINCT FROM NEW.lease_owner OR OLD.model_version IS DISTINCT FROM NEW.model_version OR OLD.config_json IS DISTINCT FROM NEW.config_json OR OLD.input_manifest_hash IS DISTINCT FROM NEW.input_manifest_hash OR OLD.started_at IS DISTINCT FROM NEW.started_at) EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_delete BEFORE DELETE ON knowledge.job_attempt FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_fields BEFORE UPDATE ON knowledge.change_set FOR EACH ROW WHEN (OLD.wiki_id IS DISTINCT FROM NEW.wiki_id OR OLD.id IS DISTINCT FROM NEW.id OR OLD.actor_id IS DISTINCT FROM NEW.actor_id OR OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.proposed_revisions_json IS DISTINCT FROM NEW.proposed_revisions_json OR OLD.expected_heads_json IS DISTINCT FROM NEW.expected_heads_json OR OLD.lineage_json IS DISTINCT FROM NEW.lineage_json OR OLD.schema_revision_id IS DISTINCT FROM NEW.schema_revision_id OR OLD.input_manifest_hash IS DISTINCT FROM NEW.input_manifest_hash OR OLD.manifest_hash IS DISTINCT FROM NEW.manifest_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION knowledge.immutable_row();
CREATE TRIGGER immutable_delete BEFORE DELETE ON knowledge.change_set FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();
