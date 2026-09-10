// 기존 미연결 금액/통화는 갱신하지 않는다. 제약은 앞으로 기록하는 관계에만 적용한다.
export function migrateProjectMoney(conn) {
  conn.exec(`ALTER TABLE budget ADD COLUMN money_currency TEXT CHECK(money_currency IS NULL OR money_currency='KRW');
    CREATE INDEX project_money_budgets ON budget(tenant_id,org_id,project_id);
    CREATE INDEX project_money_entries ON transaction_record(tenant_id,org_id,project_id,status);
    CREATE TRIGGER project_money_budget_attribution BEFORE UPDATE OF project_id,money_currency ON budget
      WHEN (OLD.project_id IS NOT NULL AND NEW.project_id IS NOT OLD.project_id)
        OR (OLD.money_currency IS NOT NULL AND NEW.money_currency IS NOT OLD.money_currency)
      BEGIN SELECT RAISE(ABORT,'project money attribution is immutable'); END;
    CREATE TRIGGER project_money_posted_attribution BEFORE UPDATE OF project_id,budget_id,tenant_id,org_id,currency ON transaction_record
      WHEN OLD.status='confirmed' AND (NEW.project_id IS NOT OLD.project_id OR NEW.budget_id IS NOT OLD.budget_id
        OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.org_id IS NOT OLD.org_id OR NEW.currency IS NOT OLD.currency)
      BEGIN SELECT RAISE(ABORT,'posted project attribution is immutable'); END;
  `);
  for (const event of ['INSERT', 'UPDATE OF project_id,account_id,tenant_id,org_id']) conn.exec(`
    CREATE TRIGGER project_money_budget_${event === 'INSERT' ? 'insert' : 'update'} BEFORE ${event} ON budget BEGIN
      SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project p WHERE p.id=NEW.project_id AND p.tenant_id=NEW.tenant_id AND p.org_id=NEW.org_id AND p.deleted_at IS NULL)
        THEN RAISE(ABORT,'project company scope mismatch') END;
      SELECT CASE WHEN NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account a WHERE a.id=NEW.account_id AND a.tenant_id=NEW.tenant_id AND a.org_id=NEW.org_id AND a.deleted_at IS NULL)
        THEN RAISE(ABORT,'budget account company scope mismatch') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM transaction_record t WHERE t.budget_id=NEW.id AND t.project_id IS NOT NULL AND t.project_id IS NOT NEW.project_id)
        THEN RAISE(ABORT,'budget project conflicts with ledger attribution') END;
    END;
  `);
  for (const event of ['INSERT', 'UPDATE OF project_id,budget_id,account_id,tenant_id,org_id,currency']) conn.exec(`
    CREATE TRIGGER project_money_entry_${event === 'INSERT' ? 'insert' : 'update'} BEFORE ${event} ON transaction_record BEGIN
      SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project p WHERE p.id=NEW.project_id AND p.tenant_id=NEW.tenant_id AND p.org_id=NEW.org_id AND p.deleted_at IS NULL)
        THEN RAISE(ABORT,'entry project company scope mismatch') END;
      SELECT CASE WHEN NEW.budget_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM budget b WHERE b.id=NEW.budget_id AND b.tenant_id=NEW.tenant_id AND b.org_id=NEW.org_id AND b.deleted_at IS NULL
        AND (NEW.project_id IS NULL OR b.project_id=NEW.project_id) AND (b.money_currency IS NULL OR b.money_currency=NEW.currency)
        AND (b.account_id IS NULL OR b.account_id=NEW.account_id))
        THEN RAISE(ABORT,'entry budget project company scope mismatch') END;
      SELECT CASE WHEN NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account a WHERE a.id=NEW.account_id AND a.tenant_id=NEW.tenant_id AND a.org_id=NEW.org_id AND a.deleted_at IS NULL)
        THEN RAISE(ABORT,'entry account company scope mismatch') END;
    END;
  `);
}
