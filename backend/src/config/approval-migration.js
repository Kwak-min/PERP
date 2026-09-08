function columnsOf(conn, table) {
  return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function addColumn(conn, table, definition) {
  const name = definition.split(/\s+/, 1)[0];
  if (!columnsOf(conn, table).has(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

// Add a second guard for already-migrated stores; never remove or disable the original trigger.
export function migrateApprovalSnapshotBoundary(conn) {
  conn.exec(`
    CREATE TRIGGER IF NOT EXISTS approval_submitted_boundary_update BEFORE UPDATE ON approval
      WHEN OLD.workflow_locked=1 AND (
        OLD.workflow_locked IS NOT NEW.workflow_locked OR NEW.status NOT IN ('pending','approved','rejected','withdrawn')
        OR OLD.id IS NOT NEW.id OR OLD.tenant_id IS NOT NEW.tenant_id OR OLD.org_id IS NOT NEW.org_id
        OR OLD.requester_id IS NOT NEW.requester_id OR OLD.payload IS NOT NEW.payload
        OR OLD.submitted_at IS NOT NEW.submitted_at OR OLD.due_at IS NOT NEW.due_at
        OR OLD.created_at IS NOT NEW.created_at OR OLD.created_by IS NOT NEW.created_by OR OLD.deleted_at IS NOT NEW.deleted_at
      ) BEGIN SELECT RAISE(ABORT,'submitted approval snapshot boundary is immutable'); END;
  `);
}

// 기존 즉시 제출 결재는 그대로 두고, 전용 draft workflow에 필요한 저장소만 추가한다.
export function migrateApprovalWorkflow(conn) {
  for (const definition of [
    "body_json TEXT NOT NULL DEFAULT '{}'",
    'form_revision INTEGER',
    'form_snapshot_json TEXT',
    "attachment_snapshot_json TEXT NOT NULL DEFAULT '[]'",
    'predecessor_id TEXT',
    "steps_json TEXT NOT NULL DEFAULT '[]'",
    'workflow_locked INTEGER NOT NULL DEFAULT 0',
    'submitted_at TEXT',
    'withdrawn_at TEXT',
  ]) addColumn(conn, 'approval', definition);

  conn.exec(`
    CREATE TABLE IF NOT EXISTS approval_history (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, org_id TEXT NOT NULL,
      approval_id TEXT NOT NULL REFERENCES approval(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_approval_history_parent
      ON approval_history(tenant_id,org_id,approval_id,created_at,id);
    CREATE TRIGGER IF NOT EXISTS approval_history_update BEFORE UPDATE ON approval_history
      BEGIN SELECT RAISE(ABORT,'approval history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_history_delete BEFORE DELETE ON approval_history
      BEGIN SELECT RAISE(ABORT,'approval history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_terminal_update BEFORE UPDATE ON approval
      WHEN OLD.status IN ('approved','rejected','withdrawn')
      BEGIN SELECT RAISE(ABORT,'terminal approval is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_submitted_snapshot_update BEFORE UPDATE ON approval
      WHEN OLD.workflow_locked=1 AND (
        OLD.title IS NOT NEW.title OR OLD.form_key IS NOT NEW.form_key OR OLD.body_json IS NOT NEW.body_json
        OR OLD.form_revision IS NOT NEW.form_revision OR OLD.form_snapshot_json IS NOT NEW.form_snapshot_json
        OR OLD.attachment_snapshot_json IS NOT NEW.attachment_snapshot_json OR OLD.subject_type IS NOT NEW.subject_type
        OR OLD.subject_id IS NOT NEW.subject_id OR OLD.amount IS NOT NEW.amount OR OLD.steps_json IS NOT NEW.steps_json
        OR OLD.predecessor_id IS NOT NEW.predecessor_id
      ) BEGIN SELECT RAISE(ABORT,'submitted approval snapshot is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_terminal_delete BEFORE DELETE ON approval
      WHEN OLD.status IN ('approved','rejected','withdrawn') OR (OLD.status='pending' AND OLD.workflow_locked=1)
      BEGIN SELECT RAISE(ABORT,'submitted approval is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_terminal_step_update BEFORE UPDATE ON approval_step
      WHEN EXISTS(SELECT 1 FROM approval a WHERE a.id=OLD.approval_id AND a.status IN ('approved','rejected','withdrawn'))
      BEGIN SELECT RAISE(ABORT,'terminal approval step is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_terminal_step_delete BEFORE DELETE ON approval_step
      WHEN EXISTS(SELECT 1 FROM approval a WHERE a.id=OLD.approval_id AND a.status IN ('approved','rejected','withdrawn'))
      BEGIN SELECT RAISE(ABORT,'terminal approval step is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_snapshot_receipt_insert BEFORE INSERT ON approval_receipt_files
      WHEN EXISTS(SELECT 1 FROM approval a WHERE a.id=NEW.approval_id AND a.workflow_locked=1)
      BEGIN SELECT RAISE(ABORT,'submitted approval attachment snapshot is immutable'); END;
  `);
}
