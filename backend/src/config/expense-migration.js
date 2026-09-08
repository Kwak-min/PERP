// 신규 실지출만 강한 원본 보존을 적용한다. 과거 agent draft 복원 workflow는 변환하지 않는다.
export function migrateExpenses(conn) {
  conn.exec(`
    CREATE TABLE finance_request_replay (
      tenant_id TEXT NOT NULL, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      operation TEXT NOT NULL, request_key TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(tenant_id,org_id,actor_id,operation,request_key)
    );
    CREATE TRIGGER expense_original_update BEFORE UPDATE ON transaction_record
      WHEN OLD.status='confirmed' AND OLD.input_currency='KRW'
      BEGIN SELECT RAISE(ABORT,'confirmed expense is immutable'); END;
    CREATE TRIGGER expense_original_delete BEFORE DELETE ON transaction_record
      WHEN OLD.status='confirmed' AND OLD.input_currency='KRW'
      BEGIN SELECT RAISE(ABORT,'confirmed expense is immutable'); END;
  `);
}
