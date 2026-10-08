-- Task20: v13/v14 approvals, v15 Wiki와 분리한 additive migration.
BEGIN;
CREATE TABLE IF NOT EXISTS accounting.expense_import_uploads (
  id uuid PRIMARY KEY, source text NOT NULL DEFAULT 'perp_db' CHECK(source='perp_db'),
  company_id bigint NOT NULL REFERENCES org.companies(id), actor_id bigint NOT NULL REFERENCES auth.users(id),
  raw bytea NOT NULL CHECK(octet_length(raw)<=5242880), raw_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours'
);
CREATE INDEX IF NOT EXISTS expense_import_upload_expiry ON accounting.expense_import_uploads(expires_at);
CREATE TABLE IF NOT EXISTS accounting.expense_import_jobs (
  id uuid PRIMARY KEY, source text NOT NULL DEFAULT 'perp_db' CHECK(source='perp_db'),
  company_id bigint NOT NULL REFERENCES org.companies(id), actor_id bigint NOT NULL REFERENCES auth.users(id),
  upload_id uuid NOT NULL, snapshot jsonb NOT NULL, audit_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL CHECK(state IN ('ready','invalid','superseded','completed')),
  request_key text, result jsonb, result_rows jsonb,
  UNIQUE(company_id,id),
  CHECK((state='completed' AND request_key IS NOT NULL AND result IS NOT NULL AND result_rows IS NOT NULL)
    OR (state<>'completed' AND request_key IS NULL AND result IS NULL AND result_rows IS NULL))
);
CREATE TABLE IF NOT EXISTS accounting.imported_transaction_identities (
  company_id bigint NOT NULL REFERENCES org.companies(id), identity_key text NOT NULL,
  identity_value text NOT NULL, payload_sha256 text NOT NULL, transaction_id bigint NOT NULL, job_id uuid NOT NULL,
  -- 4KiB external ID도 btree tuple 크기 한도를 넘지 않는다. 정확한 identity는 비교 전에 따로 보존한다.
  PRIMARY KEY(company_id,identity_key),
  CHECK(identity_key=encode(sha256(convert_to(identity_value,'UTF8')),'hex')),
  FOREIGN KEY(company_id,transaction_id) REFERENCES accounting.journal_entries(company_id,id),
  FOREIGN KEY(company_id,job_id) REFERENCES accounting.expense_import_jobs(company_id,id)
);
CREATE OR REPLACE FUNCTION accounting.guard_expense_import_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'expense import job immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.source,NEW.company_id,NEW.actor_id,NEW.upload_id,NEW.audit_snapshot,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.source,OLD.company_id,OLD.actor_id,OLD.upload_id,OLD.audit_snapshot,OLD.created_at)
    OR NOT (
      (NEW.snapshot=OLD.snapshot AND OLD.state NOT IN ('completed','superseded') AND NEW.state IN ('completed','superseded'))
      OR (OLD.snapshot<>OLD.audit_snapshot AND NEW.snapshot=OLD.audit_snapshot
        AND (NEW.state,NEW.request_key,NEW.result,NEW.result_rows)
          IS NOT DISTINCT FROM (OLD.state,OLD.request_key,OLD.result,OLD.result_rows)
        AND NOT EXISTS (SELECT 1 FROM accounting.expense_import_uploads
          WHERE id=OLD.upload_id AND expires_at>clock_timestamp()))
    ) THEN
    RAISE EXCEPTION 'expense import job immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS expense_import_job_immutable ON accounting.expense_import_jobs;
CREATE TRIGGER expense_import_job_immutable BEFORE UPDATE OR DELETE ON accounting.expense_import_jobs
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_expense_import_job();
CREATE OR REPLACE FUNCTION accounting.guard_imported_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'expense import identity immutable' USING ERRCODE='23514'; END $$;
DROP TRIGGER IF EXISTS expense_import_identity_immutable ON accounting.imported_transaction_identities;
CREATE TRIGGER expense_import_identity_immutable BEFORE UPDATE OR DELETE ON accounting.imported_transaction_identities
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_imported_identity();
COMMIT;
