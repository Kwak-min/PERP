-- Daily financial core. Apply only after v1-v7, with deployment approval/backup.
-- No existing rows are removed, normalized, or granted permissions.
BEGIN;
ALTER TABLE accounting.budgets ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounting.settlements ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounting.dues_charges ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounting.dues_payments ADD COLUMN IF NOT EXISTS recorded_by BIGINT REFERENCES auth.users(id);

CREATE TABLE IF NOT EXISTS accounting.request_replays (
  company_id BIGINT NOT NULL REFERENCES org.companies(id),
  actor_id BIGINT NOT NULL REFERENCES auth.users(id),
  operation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,actor_id,operation,request_key)
);
CREATE TABLE IF NOT EXISTS accounting.record_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES org.companies(id),
  actor_id BIGINT NOT NULL REFERENCES auth.users(id),
  resource TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_record_events_resource ON accounting.record_events(company_id,resource,resource_id,id);

-- NOT VALID preserves legacy zero/negative rows pending a separate data review,
-- while enforcing positivity on every newly inserted/updated row.
DO $$ DECLARE target TEXT; BEGIN
  FOREACH target IN ARRAY ARRAY['budgets','settlements','dues_charges','dues_payments'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='daily_positive_amount' AND conrelid=('accounting.'||target)::regclass) THEN
      EXECUTE format('ALTER TABLE accounting.%I ADD CONSTRAINT daily_positive_amount CHECK (amount > 0) NOT VALID',target);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION accounting.retain_daily_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    IF OLD.posted THEN RAISE EXCEPTION 'posted journal retained' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME = 'dues_charges' THEN
    IF OLD.status IN ('paid','partial','waived') OR EXISTS(SELECT 1 FROM accounting.dues_payments WHERE charge_id=OLD.id) THEN
      RAISE EXCEPTION 'paid charge retained' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'settlements' THEN
    IF OLD.status <> 'pending' OR OLD.journal_entry_id IS NOT NULL THEN RAISE EXCEPTION 'settlement retained' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME = 'approval_requests' THEN
    IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'decided approval retained' USING ERRCODE='23514'; END IF;
  ELSE
    RAISE EXCEPTION 'audit/payment history retained' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE OR REPLACE TRIGGER daily_retain_journal BEFORE DELETE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.retain_daily_records();
CREATE OR REPLACE TRIGGER daily_retain_dues BEFORE DELETE ON accounting.dues_charges FOR EACH ROW EXECUTE FUNCTION accounting.retain_daily_records();
CREATE OR REPLACE TRIGGER daily_retain_settlement BEFORE DELETE ON accounting.settlements FOR EACH ROW EXECUTE FUNCTION accounting.retain_daily_records();
CREATE OR REPLACE TRIGGER daily_retain_approval BEFORE DELETE ON org.approval_requests FOR EACH ROW EXECUTE FUNCTION accounting.retain_daily_records();
CREATE OR REPLACE TRIGGER daily_retain_payments BEFORE UPDATE OR DELETE ON accounting.dues_payments FOR EACH ROW EXECUTE FUNCTION accounting.retain_daily_records();
CREATE OR REPLACE TRIGGER daily_retain_events BEFORE UPDATE OR DELETE ON accounting.record_events FOR EACH ROW EXECUTE FUNCTION accounting.retain_daily_records();

CREATE OR REPLACE FUNCTION accounting.check_daily_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debit_total NUMERIC; credit_total NUMERIC; line_count INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND OLD.posted THEN RAISE EXCEPTION 'posted journal retained' USING ERRCODE='23514'; END IF;
  IF NEW.posted THEN
    SELECT SUM(debit),SUM(credit),COUNT(*) INTO debit_total,credit_total,line_count FROM accounting.journal_lines WHERE entry_id=NEW.id;
    IF line_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
      RAISE EXCEPTION 'journal must be positive and balanced before posting' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER daily_check_journal BEFORE INSERT OR UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.check_daily_journal();
CREATE OR REPLACE FUNCTION accounting.check_daily_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry accounting.journal_entries; entry_key BIGINT;
BEGIN
  entry_key := CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  SELECT * INTO entry FROM accounting.journal_entries WHERE id=entry_key FOR UPDATE;
  IF entry.posted OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM accounting.journal_entries WHERE id=OLD.entry_id AND posted)) THEN
    RAISE EXCEPTION 'posted journal lines retained' USING ERRCODE='23514';
  END IF;
  IF TG_OP <> 'DELETE' AND NOT EXISTS(SELECT 1 FROM accounting.accounts WHERE id=NEW.account_id AND company_id=entry.company_id) THEN
    RAISE EXCEPTION 'journal account must belong to company' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER daily_check_line BEFORE INSERT OR UPDATE OR DELETE ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION accounting.check_daily_line();
COMMIT;
