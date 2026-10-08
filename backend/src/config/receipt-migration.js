// 기존 원본과 장부는 보존하고 새 원증빙만 강한 연결 경계를 적용한다.
export function migrateReceipts(conn) {
  for (const definition of ['counterparty TEXT', 'occurred_at TEXT', 'input_currency TEXT', 'no_receipt_reason TEXT']) {
    conn.exec(`ALTER TABLE transaction_record ADD COLUMN ${definition}`);
  }
  conn.exec(`
    ALTER TABLE transaction_evidence ADD COLUMN org_id TEXT;
    ALTER TABLE transaction_evidence ADD COLUMN receipt_upload_id TEXT;
    CREATE TABLE receipt_upload (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK(source='legacy'), tenant_id TEXT NOT NULL, org_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('transaction','approval')),
      storage_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL, extension TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760), checksum_sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('writing','ready','consumed','deleted')),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_file_id TEXT, cleanup_error TEXT,
      UNIQUE(id,tenant_id,org_id)
    );
    CREATE INDEX receipt_upload_expiry ON receipt_upload(state,expires_at);
    CREATE TABLE approval_receipt_files (
      approval_id TEXT NOT NULL REFERENCES approval(id) ON DELETE RESTRICT,
      file_id TEXT NOT NULL REFERENCES file_object(id) ON DELETE RESTRICT,
      tenant_id TEXT NOT NULL, org_id TEXT NOT NULL, receipt_upload_id TEXT NOT NULL UNIQUE REFERENCES receipt_upload(id),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(approval_id,file_id)
    );
    CREATE TRIGGER receipt_evidence_scope BEFORE INSERT ON transaction_evidence WHEN NEW.receipt_upload_id IS NOT NULL BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM transaction_record p JOIN file_object f ON f.id=NEW.file_id
        JOIN receipt_upload u ON u.id=NEW.receipt_upload_id
        WHERE p.id=NEW.transaction_id AND p.tenant_id=NEW.tenant_id AND p.org_id=NEW.org_id
          AND f.tenant_id=p.tenant_id AND f.org_id=p.org_id AND u.tenant_id=p.tenant_id AND u.org_id=p.org_id
          AND u.kind='transaction' AND u.state='ready' AND u.storage_key=f.storage_key
      ) THEN RAISE(ABORT,'receipt scope mismatch') END;
    END;
    CREATE TRIGGER receipt_approval_scope BEFORE INSERT ON approval_receipt_files BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM approval p JOIN file_object f ON f.id=NEW.file_id JOIN receipt_upload u ON u.id=NEW.receipt_upload_id
        WHERE p.id=NEW.approval_id AND p.tenant_id=NEW.tenant_id AND p.org_id=NEW.org_id
          AND f.tenant_id=p.tenant_id AND f.org_id=p.org_id AND u.tenant_id=p.tenant_id AND u.org_id=p.org_id
          AND u.kind='approval' AND u.state='ready' AND u.storage_key=f.storage_key
      ) THEN RAISE(ABORT,'receipt scope mismatch') END;
    END;
    CREATE TRIGGER receipt_evidence_update BEFORE UPDATE ON transaction_evidence WHEN OLD.receipt_upload_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt is immutable'); END;
    CREATE TRIGGER receipt_evidence_delete BEFORE DELETE ON transaction_evidence WHEN OLD.receipt_upload_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt is immutable'); END;
    CREATE TRIGGER receipt_approval_update BEFORE UPDATE ON approval_receipt_files BEGIN SELECT RAISE(ABORT,'receipt is immutable'); END;
    CREATE TRIGGER receipt_approval_delete BEFORE DELETE ON approval_receipt_files BEGIN SELECT RAISE(ABORT,'receipt is immutable'); END;
    CREATE TRIGGER receipt_file_update BEFORE UPDATE ON file_object WHEN EXISTS(SELECT 1 FROM receipt_upload WHERE consumed_file_id=OLD.id) BEGIN SELECT RAISE(ABORT,'receipt original is immutable'); END;
    CREATE TRIGGER receipt_file_delete BEFORE DELETE ON file_object WHEN EXISTS(SELECT 1 FROM receipt_upload WHERE consumed_file_id=OLD.id) BEGIN SELECT RAISE(ABORT,'receipt original is immutable'); END;
  `);
}
