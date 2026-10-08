-- v21 프로젝트 재무: 기존 미연결 전표/예산과 통화는 변경하지 않는다.
BEGIN;
ALTER TABLE accounting.budgets ADD COLUMN IF NOT EXISTS project_id BIGINT;
ALTER TABLE accounting.budgets ADD COLUMN IF NOT EXISTS money_currency TEXT CHECK(money_currency IS NULL OR money_currency='KRW');
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS project_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS project_money_company_project ON project.projects(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS project_money_company_account ON accounting.accounts(company_id,id);
CREATE INDEX IF NOT EXISTS project_money_budgets ON accounting.budgets(company_id,project_id);
CREATE INDEX IF NOT EXISTS project_money_entries ON accounting.journal_entries(company_id,project_id) WHERE posted;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='project_money_budget_project' AND conrelid='accounting.budgets'::regclass) THEN
    ALTER TABLE accounting.budgets ADD CONSTRAINT project_money_budget_project FOREIGN KEY(company_id,project_id) REFERENCES project.projects(company_id,id) ON DELETE RESTRICT NOT VALID;
    ALTER TABLE accounting.budgets ADD CONSTRAINT project_money_budget_account FOREIGN KEY(company_id,account_id) REFERENCES accounting.accounts(company_id,id) ON DELETE RESTRICT NOT VALID;
    ALTER TABLE accounting.journal_entries ADD CONSTRAINT project_money_entry_project FOREIGN KEY(company_id,project_id) REFERENCES project.projects(company_id,id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION accounting.project_money_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND ((OLD.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id)
    OR (OLD.money_currency IS NOT NULL AND NEW.money_currency IS DISTINCT FROM OLD.money_currency)) THEN
    RAISE EXCEPTION 'project money attribution is immutable' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM accounting.journal_entries e WHERE e.budget_id=NEW.id AND e.project_id IS NOT NULL AND e.project_id IS DISTINCT FROM NEW.project_id) THEN
    RAISE EXCEPTION 'budget project conflicts with ledger attribution' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION accounting.project_money_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.budget_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting.budgets b WHERE b.id=NEW.budget_id AND b.company_id=NEW.company_id
    AND (NEW.project_id IS NULL OR b.project_id=NEW.project_id)
    AND (b.money_currency IS NULL OR NEW.input_currency IS NULL OR b.money_currency=NEW.input_currency)) THEN
    RAISE EXCEPTION 'entry budget project company mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER project_money_budget_guard BEFORE INSERT OR UPDATE OF project_id,money_currency,company_id ON accounting.budgets FOR EACH ROW EXECUTE FUNCTION accounting.project_money_budget_guard();
CREATE OR REPLACE TRIGGER project_money_entry_guard BEFORE INSERT OR UPDATE OF project_id,budget_id,company_id,input_currency ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION accounting.project_money_entry_guard();
COMMIT;
