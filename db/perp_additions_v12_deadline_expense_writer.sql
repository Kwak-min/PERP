-- v12 원증빙 metadata 다음 적용. 금액은 기존 전표/lines만 소유한다.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS budgets_company_id_unique ON accounting.budgets(company_id,id);
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS budget_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expense_budget_company' AND conrelid='accounting.journal_entries'::regclass) THEN
    ALTER TABLE accounting.journal_entries ADD CONSTRAINT expense_budget_company
      FOREIGN KEY(company_id,budget_id) REFERENCES accounting.budgets(company_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
COMMIT;
