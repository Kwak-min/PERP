import { migrateReceipts } from './receipt-migration.js';
import { migrateExpenses } from './expense-migration.js';
import { migrateApprovalWorkflow, migrateApprovalSnapshotBoundary } from './approval-migration.js';
import { migrateExpenseImports } from './expense-import-migration.js';

function columnsOf(conn, table) {
  return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumn(conn, table, definition) {
  const [name] = definition.split(/\s+/, 1);
  if (!columnsOf(conn, table).has(name)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

const MIGRATIONS = [
  {
    version: 1,
    up(conn) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS vault_source (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          name TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'obsidian_zip',
          import_mode TEXT NOT NULL DEFAULT 'merge',
          last_import_at TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT,
          updated_at TEXT NOT NULL,
          updated_by TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS vault_file (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          note_id TEXT,
          relative_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          source_mtime TEXT,
          frontmatter_json TEXT NOT NULL DEFAULT '{}',
          import_status TEXT NOT NULL DEFAULT 'imported',
          last_error TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT,
          updated_at TEXT NOT NULL,
          updated_by TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS vault_chunk (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          note_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          heading_path TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS vault_chunk_fts USING fts5(
          chunk_id UNINDEXED,
          note_id UNINDEXED,
          title,
          folder,
          tags,
          heading_path,
          content
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_vault_source_owner_name
          ON vault_source(tenant_id, owner_id, name) WHERE deleted_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_vault_file_owner_path
          ON vault_file(tenant_id, owner_id, source_id, relative_path) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS ix_vault_file_owner_source
          ON vault_file(tenant_id, owner_id, source_id, deleted_at);
        CREATE INDEX IF NOT EXISTS ix_vault_chunk_owner_note
          ON vault_chunk(tenant_id, owner_id, note_id, deleted_at);
      `);

      addColumn(conn, "vault_note", "source_id TEXT");
      addColumn(conn, "vault_note", "source_file_id TEXT");
      addColumn(conn, "vault_note", "source_path TEXT");
      addColumn(conn, "vault_note", "frontmatter_json TEXT NOT NULL DEFAULT '{}'");
      addColumn(conn, "vault_note", "content_hash TEXT");
      addColumn(conn, "vault_note", "source_mtime TEXT");
    },
  },
  {
    version: 2,
    up(conn) {
      addColumn(conn, "ai_conversation", "vault_mode TEXT NOT NULL DEFAULT 'off'");
    },
  },
  {
    version: 3,
    up(conn) {
      addColumn(conn, "app_user", "employee_number TEXT");
      addColumn(conn, "app_user", "employment_type TEXT");
      addColumn(conn, "app_user", "workplace TEXT");
      addColumn(conn, "membership", "hire_date TEXT");
      conn.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_app_user_employee_number
          ON app_user(employee_number) WHERE employee_number IS NOT NULL;
        CREATE TABLE IF NOT EXISTS project_collaboration (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          partner_name TEXT NOT NULL,
          partner_org_id TEXT,
          department_ids TEXT NOT NULL DEFAULT '',
          contact_name TEXT,
          contact_email TEXT,
          contact_phone TEXT,
          access_level TEXT NOT NULL DEFAULT 'viewer',
          share_scopes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          starts_on TEXT,
          ends_on TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT,
          updated_at TEXT NOT NULL,
          updated_by TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_project_collaboration_project
          ON project_collaboration(tenant_id, org_id, project_id, deleted_at);
      `);
    },
  },
  {
    version: 4,
    up(conn) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS home_layout (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          department_id TEXT,
          project_id TEXT,
          blocks_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          created_by TEXT,
          updated_at TEXT NOT NULL,
          updated_by TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          deleted_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_home_layout_scope
          ON home_layout(tenant_id, org_id, ifnull(department_id, ''), ifnull(project_id, ''))
          WHERE deleted_at IS NULL;
      `);
    },
  },
  {
    version: 5,
    up(conn) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS auth_identity (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          subject TEXT NOT NULL,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(provider, subject),
          UNIQUE(provider, user_id)
        );
        CREATE INDEX IF NOT EXISTS ix_auth_identity_user ON auth_identity(user_id);
      `);
    },
  },
  {
    version: 6,
    up(conn) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS ai_user_key (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider = 'openrouter'),
          ciphertext TEXT NOT NULL,
          nonce TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT,
          updated_at TEXT NOT NULL,
          updated_by TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          deleted_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_user_key_owner
          ON ai_user_key(tenant_id, org_id, user_id, provider) WHERE deleted_at IS NULL;
      `);
    },
  },
  {
    version: 7,
    up(conn) {
      // NULL은 분리 기능 설정 이전 조직이다. 신규 조직만 명시적인 빈 문자열/선택값을 저장한다.
      addColumn(conn, "organization", "enabled_features TEXT");
    },
  },
  {
    version: 8,
    up(conn) {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS company_role (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, org_id TEXT NOT NULL,
          name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'self',
          permissions_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL, created_by TEXT,
          updated_at TEXT NOT NULL, updated_by TEXT,
          version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_company_role_name
          ON company_role(tenant_id, org_id, name) WHERE deleted_at IS NULL;
      `);
    },
  },
  {
    version: 9,
    up(conn) {
      // 일반 membership version과 독립적인 역할 교체 CAS.
      addColumn(conn, 'membership', 'roles_version INTEGER NOT NULL DEFAULT 1');
    },
  },
];

MIGRATIONS.push({
  version: 10,
  up(conn) {
    migrateReceipts(conn);
    migrateExpenses(conn);
  },
});
MIGRATIONS.push({
  version: 11,
  up(conn) {
    migrateApprovalWorkflow(conn);
    migrateApprovalSnapshotBoundary(conn);
  },
});

// Version 12 is reserved for Wiki; applied versions need not be contiguous.
MIGRATIONS.push({ version: 13, up: migrateExpenseImports });

export function applyMigrations(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    conn.prepare("SELECT version FROM schema_migration").all().map((row) => row.version),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    migration.up(conn);
    conn
      .prepare("INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)")
      .run(migration.version, new Date().toISOString());
  }
  return MIGRATIONS.length;
}
