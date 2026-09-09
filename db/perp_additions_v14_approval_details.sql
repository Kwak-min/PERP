-- Dedicated approval drafts/details. Apply only after v13 committed.
BEGIN;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS form_key TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS body JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS form_revision INTEGER;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS form_snapshot JSONB;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS attachment_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS predecessor_id BIGINT REFERENCES org.approval_requests(id) ON DELETE RESTRICT;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS workflow_locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE org.approval_requests ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS org.approval_forms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES org.companies(id) ON DELETE RESTRICT,
  form_key TEXT NOT NULL,
  name TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id,form_key)
);
CREATE TABLE IF NOT EXISTS org.approval_request_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL,
  approval_id BIGINT NOT NULL,
  actor_id BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  status common.approval_status NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,approval_id) REFERENCES org.approval_requests(company_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS approval_history_parent ON org.approval_request_history(company_id,approval_id,id);

CREATE OR REPLACE FUNCTION org.approval_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'approval history is immutable' USING ERRCODE='23514'; END $$;
CREATE OR REPLACE FUNCTION org.approval_parent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (OLD.status IN ('approved','rejected','withdrawn') OR (OLD.status='pending' AND OLD.workflow_locked)) THEN
    RAISE EXCEPTION 'submitted approval is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status IN ('approved','rejected','withdrawn') THEN
    RAISE EXCEPTION 'terminal approval is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.workflow_locked AND (
    OLD.title IS DISTINCT FROM NEW.title OR OLD.form_key IS DISTINCT FROM NEW.form_key OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.form_revision IS DISTINCT FROM NEW.form_revision OR OLD.form_snapshot IS DISTINCT FROM NEW.form_snapshot
    OR OLD.attachment_snapshot IS DISTINCT FROM NEW.attachment_snapshot OR OLD.request_type IS DISTINCT FROM NEW.request_type
    OR OLD.target_user_id IS DISTINCT FROM NEW.target_user_id OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.predecessor_id IS DISTINCT FROM NEW.predecessor_id
    OR OLD.workflow_locked IS DISTINCT FROM NEW.workflow_locked OR NEW.status NOT IN ('pending','approved','rejected','withdrawn')
    OR OLD.id IS DISTINCT FROM NEW.id OR OLD.company_id IS DISTINCT FROM NEW.company_id
    OR OLD.requester_id IS DISTINCT FROM NEW.requester_id OR OLD.submitted_at IS DISTINCT FROM NEW.submitted_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN RAISE EXCEPTION 'submitted approval snapshot is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION org.approval_snapshot_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM org.approval_requests a WHERE a.id=NEW.approval_id AND a.company_id=NEW.company_id AND a.workflow_locked) THEN
    RAISE EXCEPTION 'submitted approval attachment snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER approval_history_immutable BEFORE UPDATE OR DELETE ON org.approval_request_history FOR EACH ROW EXECUTE FUNCTION org.approval_history_immutable();
CREATE OR REPLACE TRIGGER approval_parent_guard BEFORE UPDATE OR DELETE ON org.approval_requests FOR EACH ROW EXECUTE FUNCTION org.approval_parent_guard();
CREATE OR REPLACE TRIGGER approval_snapshot_receipt_guard BEFORE INSERT ON org.approval_request_files FOR EACH ROW EXECUTE FUNCTION org.approval_snapshot_receipt_guard();
COMMIT;
