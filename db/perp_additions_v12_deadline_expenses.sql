-- 원증빙 경계 및 후속 실지출 소비용 nullable metadata. 기존 장부를 변환하지 않는다.
BEGIN;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS counterparty TEXT;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS input_currency TEXT;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS no_receipt_reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_company_id_unique ON accounting.journal_entries(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_company_id_unique ON org.approval_requests(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS objects_company_id_unique ON files.objects(company_id,id);
CREATE TABLE IF NOT EXISTS files.receipt_uploads (
  id UUID PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source='perp_db'), company_id BIGINT NOT NULL REFERENCES org.companies(id) ON DELETE RESTRICT,
  actor_id BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK(kind IN ('transaction','approval')),
  storage_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL, extension TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760), checksum_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('writing','ready','consumed','deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(), expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+interval '24 hours',
  consumed_file_id BIGINT, cleanup_error TEXT,
  UNIQUE(company_id,id), FOREIGN KEY(company_id,consumed_file_id) REFERENCES files.objects(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS receipt_uploads_expiry ON files.receipt_uploads(state,expires_at);
CREATE TABLE IF NOT EXISTS accounting.journal_entry_files (
  company_id BIGINT NOT NULL, entry_id BIGINT NOT NULL, file_id BIGINT NOT NULL,
  receipt_upload_id UUID NOT NULL UNIQUE, created_by BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(entry_id,file_id),
  FOREIGN KEY(company_id,entry_id) REFERENCES accounting.journal_entries(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,file_id) REFERENCES files.objects(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,receipt_upload_id) REFERENCES files.receipt_uploads(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS org.approval_request_files (
  company_id BIGINT NOT NULL, approval_id BIGINT NOT NULL, file_id BIGINT NOT NULL,
  receipt_upload_id UUID NOT NULL UNIQUE, created_by BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(approval_id,file_id),
  FOREIGN KEY(company_id,approval_id) REFERENCES org.approval_requests(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,file_id) REFERENCES files.objects(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,receipt_upload_id) REFERENCES files.receipt_uploads(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS files.receipt_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, company_id BIGINT NOT NULL, kind TEXT NOT NULL, parent_id BIGINT NOT NULL,
  file_id BIGINT NOT NULL REFERENCES files.objects(id) ON DELETE RESTRICT,
  actor_id BIGINT NOT NULL, checksum_sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION files.receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'receipt original/link is immutable' USING ERRCODE='23514'; END $$;
CREATE OR REPLACE FUNCTION files.receipt_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM files.receipt_uploads WHERE consumed_file_id=OLD.id) THEN
    RAISE EXCEPTION 'receipt original is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION files.receipt_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM files.receipt_uploads u JOIN files.objects f ON f.storage_key=u.storage_key
    AND f.storage_bucket='orbitflow-local' AND f.company_id=u.company_id
    WHERE u.id=NEW.receipt_upload_id AND u.company_id=NEW.company_id AND f.id=NEW.file_id AND u.state='ready' AND u.kind=TG_ARGV[0]) THEN
    RAISE EXCEPTION 'receipt scope mismatch' USING ERRCODE='23514';
  END IF; RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER receipt_journal_link_guard BEFORE INSERT ON accounting.journal_entry_files FOR EACH ROW EXECUTE FUNCTION files.receipt_link_guard('transaction');
CREATE OR REPLACE TRIGGER receipt_approval_link_guard BEFORE INSERT ON org.approval_request_files FOR EACH ROW EXECUTE FUNCTION files.receipt_link_guard('approval');
CREATE OR REPLACE TRIGGER receipt_journal_immutable BEFORE UPDATE OR DELETE ON accounting.journal_entry_files FOR EACH ROW EXECUTE FUNCTION files.receipt_immutable();
CREATE OR REPLACE TRIGGER receipt_approval_immutable BEFORE UPDATE OR DELETE ON org.approval_request_files FOR EACH ROW EXECUTE FUNCTION files.receipt_immutable();
CREATE OR REPLACE TRIGGER receipt_events_immutable BEFORE UPDATE OR DELETE ON files.receipt_events FOR EACH ROW EXECUTE FUNCTION files.receipt_immutable();
CREATE OR REPLACE TRIGGER receipt_file_immutable BEFORE UPDATE OR DELETE ON files.objects FOR EACH ROW EXECUTE FUNCTION files.receipt_file_guard();
COMMIT;
