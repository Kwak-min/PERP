// 11은 결재, 12는 Wiki에 예약되어 있다. CSV import는 13만 사용한다.
export function migrateExpenseImports(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS expense_import_uploads (
      id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'legacy' CHECK(source='legacy'),
      tenant_id TEXT NOT NULL, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      raw BLOB NOT NULL CHECK(length(raw)<=5242880), raw_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS expense_import_upload_expiry ON expense_import_uploads(expires_at);
    CREATE TABLE IF NOT EXISTS expense_import_jobs (
      id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'legacy' CHECK(source='legacy'),
      tenant_id TEXT NOT NULL, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      upload_id TEXT NOT NULL, snapshot TEXT NOT NULL, audit_snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','invalid','superseded','completed')),
      request_key TEXT, result TEXT, result_rows TEXT,
      UNIQUE(tenant_id,org_id,id),
      CHECK((state='completed' AND request_key IS NOT NULL AND result IS NOT NULL AND result_rows IS NOT NULL)
        OR (state<>'completed' AND request_key IS NULL AND result IS NULL AND result_rows IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS transaction_import_company_id ON transaction_record(tenant_id,org_id,id);
    CREATE TABLE IF NOT EXISTS imported_transaction_identities (
      tenant_id TEXT NOT NULL, org_id TEXT NOT NULL, identity_key TEXT NOT NULL,
      identity_value TEXT NOT NULL, payload_sha256 TEXT NOT NULL, transaction_id TEXT NOT NULL, job_id TEXT NOT NULL,
      PRIMARY KEY(tenant_id,org_id,identity_key),
      UNIQUE(tenant_id,org_id,identity_value),
      FOREIGN KEY(tenant_id,org_id,transaction_id) REFERENCES transaction_record(tenant_id,org_id,id),
      FOREIGN KEY(tenant_id,org_id,job_id) REFERENCES expense_import_jobs(tenant_id,org_id,id)
    );
    CREATE TRIGGER IF NOT EXISTS expense_import_job_immutable BEFORE UPDATE ON expense_import_jobs
      WHEN NEW.id IS NOT OLD.id OR NEW.source IS NOT OLD.source OR NEW.tenant_id IS NOT OLD.tenant_id
        OR NEW.org_id IS NOT OLD.org_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.upload_id IS NOT OLD.upload_id
        OR NEW.audit_snapshot IS NOT OLD.audit_snapshot OR NEW.created_at IS NOT OLD.created_at
        OR NOT (
          (NEW.snapshot IS OLD.snapshot AND OLD.state NOT IN ('completed','superseded') AND NEW.state IN ('completed','superseded'))
          OR (OLD.snapshot IS NOT OLD.audit_snapshot AND NEW.snapshot IS OLD.audit_snapshot
            AND NEW.state IS OLD.state AND NEW.request_key IS OLD.request_key
            AND NEW.result IS OLD.result AND NEW.result_rows IS OLD.result_rows
            AND NOT EXISTS (SELECT 1 FROM expense_import_uploads WHERE id=OLD.upload_id
              AND julianday(expires_at)>julianday('now')))
        )
      BEGIN SELECT RAISE(ABORT,'expense import job immutable'); END;
    CREATE TRIGGER IF NOT EXISTS expense_import_job_preserve BEFORE DELETE ON expense_import_jobs
      BEGIN SELECT RAISE(ABORT,'expense import job immutable'); END;
    CREATE TRIGGER IF NOT EXISTS expense_import_identity_immutable BEFORE UPDATE ON imported_transaction_identities
      BEGIN SELECT RAISE(ABORT,'expense import identity immutable'); END;
    CREATE TRIGGER IF NOT EXISTS expense_import_identity_preserve BEFORE DELETE ON imported_transaction_identities
      BEGIN SELECT RAISE(ABORT,'expense import identity immutable'); END;
  `);
}
