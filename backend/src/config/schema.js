const COMMON = `
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
`;

export const TABLES = [
  `CREATE TABLE IF NOT EXISTS tenant (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'club',
    status TEXT NOT NULL DEFAULT 'active', plan_id TEXT NOT NULL DEFAULT 'free',
    timezone TEXT NOT NULL DEFAULT 'Asia/Seoul', currency TEXT NOT NULL DEFAULT 'KRW',
    created_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS organization (${COMMON},
    name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'club',
    fiscal_year_start INTEGER NOT NULL DEFAULT 1,
    terminology_profile TEXT NOT NULL DEFAULT 'club',
    terminology_json TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'KRW', timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
    modules TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS app_user (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'ko',
    timezone TEXT NOT NULL DEFAULT 'Asia/Seoul', auth_status TEXT NOT NULL DEFAULT 'active',
    mfa_secret TEXT, must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
    phone TEXT, address TEXT, birth_date TEXT, created_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS membership (${COMMON},
    user_id TEXT NOT NULL, org_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    roles TEXT NOT NULL DEFAULT 'member', department_id TEXT, title TEXT,
    joined_at TEXT, left_at TEXT, emergency_contact TEXT)`,

  `CREATE TABLE IF NOT EXISTS invitation (${COMMON},
    org_id TEXT NOT NULL, email TEXT NOT NULL, roles TEXT NOT NULL DEFAULT 'member',
    token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS department (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT, leader_id TEXT,
    active_from TEXT, active_to TEXT)`,

  // 브랜치(부서)에 들어갈 수 있는 그룹(역할). 행이 없으면 조직 전체가 들어갈 수 있다.
  `CREATE TABLE IF NOT EXISTS department_access (${COMMON},
    org_id TEXT NOT NULL, department_id TEXT NOT NULL, role TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS session_token (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, revoked_at TEXT, ip TEXT, device TEXT, created_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS audit_event (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, seq INTEGER NOT NULL,
    actor_id TEXT, actor_kind TEXT NOT NULL DEFAULT 'user', action TEXT NOT NULL,
    resource_type TEXT NOT NULL, resource_id TEXT, before_json TEXT, after_json TEXT,
    request_id TEXT, ip TEXT, ai_generated INTEGER NOT NULL DEFAULT 0, approval_id TEXT,
    prev_hash TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS notification (${COMMON},
    recipient_id TEXT NOT NULL, type TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'web',
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', related_type TEXT, related_id TEXT,
    dedupe_key TEXT, read_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS project (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', owner_id TEXT, department_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'org', start_date TEXT, end_date TEXT,
    budget_amount INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS project_member (${COMMON},
    project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`,

  `CREATE TABLE IF NOT EXISTS milestone (${COMMON},
    project_id TEXT NOT NULL, name TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL DEFAULT 'open')`,

  `CREATE TABLE IF NOT EXISTS task (${COMMON},
    org_id TEXT NOT NULL, project_id TEXT, parent_id TEXT, title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', assignee_id TEXT, status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'normal', due_at TEXT, recurrence TEXT,
    estimate_hours INTEGER NOT NULL DEFAULT 0, ai_generated INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS task_checklist_item (${COMMON},
    task_id TEXT NOT NULL, label TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS task_dependency (${COMMON},
    task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS task_comment (${COMMON},
    task_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL,
    mentions TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS event (${COMMON},
    org_id TEXT NOT NULL, calendar TEXT NOT NULL DEFAULT 'org', project_id TEXT,
    title TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, location TEXT,
    meeting_url TEXT, recurrence TEXT, external_id TEXT, external_provider TEXT, external_etag TEXT)`,

  `CREATE TABLE IF NOT EXISTS event_attendee (${COMMON},
    event_id TEXT NOT NULL, user_id TEXT NOT NULL, response TEXT NOT NULL DEFAULT 'pending')`,

  `CREATE TABLE IF NOT EXISTS space (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'org')`,

  `CREATE TABLE IF NOT EXISTS document (${COMMON},
    org_id TEXT NOT NULL, space_id TEXT, project_id TEXT, title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '', doc_type TEXT NOT NULL DEFAULT 'wiki',
    tags TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'org',
    sensitivity TEXT NOT NULL DEFAULT 'internal', owner_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0, ai_generated INTEGER NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'none')`,

  `CREATE TABLE IF NOT EXISTS document_version (${COMMON},
    document_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL DEFAULT '', author_id TEXT)`,

  `CREATE TABLE IF NOT EXISTS document_chunk (${COMMON},
    document_id TEXT NOT NULL, org_id TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'internal',
    visibility TEXT NOT NULL DEFAULT 'org', embedding TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS file_object (${COMMON},
    org_id TEXT NOT NULL, storage_key TEXT NOT NULL, filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL DEFAULT 0,
    checksum TEXT NOT NULL DEFAULT '', malware_status TEXT NOT NULL DEFAULT 'pending',
    related_type TEXT, related_id TEXT)`,

  `CREATE TABLE IF NOT EXISTS meeting (${COMMON},
    org_id TEXT NOT NULL, event_id TEXT, title TEXT NOT NULL, held_at TEXT NOT NULL,
    location TEXT, attendees TEXT NOT NULL DEFAULT '', agenda TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', raw_source TEXT NOT NULL DEFAULT '',
    ai_summary TEXT NOT NULL DEFAULT '', ai_generated INTEGER NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'draft')`,

  `CREATE TABLE IF NOT EXISTS meeting_decision (${COMMON},
    meeting_id TEXT NOT NULL, content TEXT NOT NULL, owner_id TEXT, due_at TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0, task_id TEXT, source_quote TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS handover_package (${COMMON},
    org_id TEXT NOT NULL, predecessor_id TEXT NOT NULL, successor_id TEXT,
    title TEXT NOT NULL, position TEXT NOT NULL DEFAULT '', department_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft', due_at TEXT, completed_at TEXT,
    notes TEXT NOT NULL DEFAULT '', ai_generated INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS handover_item (${COMMON},
    package_id TEXT NOT NULL, category TEXT NOT NULL, label TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '', ref_type TEXT, ref_id TEXT,
    required INTEGER NOT NULL DEFAULT 1, done INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS handover_confirmation (${COMMON},
    package_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS approval_form (${COMMON},
    org_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
    fields_json TEXT NOT NULL DEFAULT '[]', route_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1)`,

  `CREATE TABLE IF NOT EXISTS approval (${COMMON},
    org_id TEXT NOT NULL, form_key TEXT NOT NULL DEFAULT 'generic', title TEXT NOT NULL,
    requester_id TEXT NOT NULL, subject_type TEXT, subject_id TEXT,
    amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
    current_step INTEGER NOT NULL DEFAULT 0, due_at TEXT, payload TEXT NOT NULL DEFAULT '{}')`,

  `CREATE TABLE IF NOT EXISTS approval_step (${COMMON},
    approval_id TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0, approver_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'sequential', kind TEXT NOT NULL DEFAULT 'approve',
    status TEXT NOT NULL DEFAULT 'pending', comment TEXT NOT NULL DEFAULT '',
    decided_at TEXT, delegate_of TEXT)`,

  `CREATE TABLE IF NOT EXISTS account (${COMMON},
    org_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'expense', parent_id TEXT, active INTEGER NOT NULL DEFAULT 1)`,

  `CREATE TABLE IF NOT EXISTS counterparty (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, registration_no TEXT, contact TEXT)`,

  `CREATE TABLE IF NOT EXISTS transaction_record (${COMMON},
    org_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense', account_id TEXT,
    counterparty_id TEXT, project_id TEXT, department_id TEXT, budget_id TEXT,
    amount_minor INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'KRW',
    occurred_on TEXT NOT NULL, memo TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft', approval_id TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 0, ai_generated INTEGER NOT NULL DEFAULT 0,
    dedupe_key TEXT)`,

  `CREATE TABLE IF NOT EXISTS transaction_evidence (${COMMON},
    transaction_id TEXT NOT NULL, file_id TEXT NOT NULL, ocr_amount_minor INTEGER,
    ocr_date TEXT, ocr_vendor TEXT, ocr_confidence INTEGER NOT NULL DEFAULT 0,
    reviewed INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS fiscal_period_lock (${COMMON},
    org_id TEXT NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'locked',
    locked_by TEXT, reopen_approval_id TEXT)`,

  `CREATE TABLE IF NOT EXISTS budget (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'FY',
    department_id TEXT, project_id TEXT, account_id TEXT,
    amount_minor INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'approved', over_policy TEXT NOT NULL DEFAULT 'warn')`,

  `CREATE TABLE IF NOT EXISTS dues_rule (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, amount_minor INTEGER NOT NULL DEFAULT 0,
    cycle TEXT NOT NULL DEFAULT 'semester', active INTEGER NOT NULL DEFAULT 1)`,

  `CREATE TABLE IF NOT EXISTS dues_charge (${COMMON},
    org_id TEXT NOT NULL, rule_id TEXT NOT NULL, payer_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL DEFAULT 0, due_on TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unpaid', exempt_reason TEXT)`,

  `CREATE TABLE IF NOT EXISTS dues_payment (${COMMON},
    charge_id TEXT NOT NULL, amount_minor INTEGER NOT NULL DEFAULT 0, paid_on TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'transfer', transaction_id TEXT)`,

  `CREATE TABLE IF NOT EXISTS settlement (${COMMON},
    org_id TEXT NOT NULL, requester_id TEXT NOT NULL, title TEXT NOT NULL,
    amount_minor INTEGER NOT NULL DEFAULT 0, project_id TEXT, budget_id TEXT, account_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft', approval_id TEXT, transaction_id TEXT,
    evidence_reviewed INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS asset (${COMMON},
    org_id TEXT NOT NULL, asset_no TEXT NOT NULL, name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'equipment', quantity INTEGER NOT NULL DEFAULT 1,
    threshold INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'available',
    location TEXT, custodian_id TEXT, qr_code TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS asset_history (${COMMON},
    asset_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, detail TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS reservation (${COMMON},
    org_id TEXT NOT NULL, resource_type TEXT NOT NULL DEFAULT 'asset', resource_id TEXT NOT NULL,
    requester_id TEXT NOT NULL, event_id TEXT, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed', checked_in_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS attendance (${COMMON},
    org_id TEXT NOT NULL, member_id TEXT NOT NULL, on_date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'present', hours INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS leave_request (${COMMON},
    org_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'annual',
    start_on TEXT NOT NULL, end_on TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', approval_id TEXT, substitute_id TEXT)`,

  `CREATE TABLE IF NOT EXISTS leave_balance (${COMMON},
    org_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'annual',
    granted_days INTEGER NOT NULL DEFAULT 0, used_days INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS leave_policy (${COMMON},
    org_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'annual',
    default_days INTEGER NOT NULL DEFAULT 0,
    carryover_enabled INTEGER NOT NULL DEFAULT 0,
    carryover_max_days INTEGER NOT NULL DEFAULT 0,
    expiry_note TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS member_competency (${COMMON},
    org_id TEXT NOT NULL, member_id TEXT NOT NULL,
    label TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'intermediate', note TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS member_field_request (${COMMON},
    org_id TEXT NOT NULL, member_id TEXT NOT NULL, field TEXT NOT NULL,
    old_value TEXT, new_value TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    comment TEXT NOT NULL DEFAULT '', decided_by TEXT, decided_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS job_posting (${COMMON},
    org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', closes_on TEXT)`,

  `CREATE TABLE IF NOT EXISTS application (${COMMON},
    org_id TEXT NOT NULL, posting_id TEXT NOT NULL, applicant_name TEXT NOT NULL,
    applicant_email TEXT NOT NULL, applicant_phone TEXT, answers TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'applied', retain_until TEXT)`,

  `CREATE TABLE IF NOT EXISTS onboarding_item (${COMMON},
    org_id TEXT NOT NULL, member_id TEXT NOT NULL, flow TEXT NOT NULL DEFAULT 'onboarding',
    label TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS agent_profile (${COMMON},
    user_id TEXT NOT NULL, org_id TEXT NOT NULL, preset TEXT NOT NULL DEFAULT 'member',
    role_context TEXT NOT NULL DEFAULT '', preferences TEXT NOT NULL DEFAULT '{}',
    model_policy TEXT NOT NULL DEFAULT 'auto', tool_scope TEXT NOT NULL DEFAULT '')`,

  `CREATE TABLE IF NOT EXISTS agent_memory (${COMMON},
    owner_id TEXT NOT NULL, org_id TEXT NOT NULL, content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user', sensitivity TEXT NOT NULL DEFAULT 'internal',
    usage_scope TEXT NOT NULL DEFAULT 'personal', expires_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS ai_conversation (${COMMON},
    user_id TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT,
    title TEXT NOT NULL DEFAULT '새 대화', cost_micro INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS ai_message (${COMMON},
    conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]', answer_json TEXT NOT NULL DEFAULT '{}')`,

  `CREATE TABLE IF NOT EXISTS ai_request_log (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
    model TEXT NOT NULL, provider TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0, cost_micro INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0, tool_calls TEXT NOT NULL DEFAULT '[]',
    citations TEXT NOT NULL DEFAULT '[]', approval_id TEXT, result TEXT NOT NULL DEFAULT 'ok',
    error TEXT, data_class TEXT NOT NULL DEFAULT 'internal', fallback_from TEXT,
    created_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS agent_action (${COMMON},
    user_id TEXT NOT NULL, org_id TEXT NOT NULL, conversation_id TEXT, tool TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'preview', input_json TEXT NOT NULL DEFAULT '{}',
    preview_json TEXT NOT NULL DEFAULT '{}', impact TEXT NOT NULL DEFAULT '',
    requires_approval INTEGER NOT NULL DEFAULT 0, requires_reauth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT, status TEXT NOT NULL DEFAULT 'preview',
    result_json TEXT NOT NULL DEFAULT '{}', rollback_ref TEXT, executed_at TEXT,
    idempotency_key TEXT, error TEXT)`,

  `CREATE TABLE IF NOT EXISTS vault_note (${COMMON},
    owner_id TEXT NOT NULL, org_id TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '/',
    title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
    sensitivity TEXT NOT NULL DEFAULT 'personal', agent_enabled INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS vault_link (${COMMON},
    owner_id TEXT NOT NULL, source_id TEXT NOT NULL, target_title TEXT NOT NULL, target_id TEXT)`,

  `CREATE TABLE IF NOT EXISTS workflow (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, trigger_type TEXT NOT NULL,
    trigger_config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft',
    active_revision INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS workflow_version (${COMMON},
    workflow_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    definition TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', published_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS workflow_run (${COMMON},
    workflow_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'running', input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT NOT NULL DEFAULT '{}', failed_step INTEGER, request_id TEXT,
    triggered_by TEXT, sandbox INTEGER NOT NULL DEFAULT 0, finished_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS workflow_step_run (${COMMON},
    run_id TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok', input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT NOT NULL DEFAULT '{}', error TEXT)`,

  `CREATE TABLE IF NOT EXISTS integration (${COMMON},
    org_id TEXT NOT NULL, provider TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '',
    token_ref TEXT NOT NULL DEFAULT '', owner_id TEXT, health TEXT NOT NULL DEFAULT 'unknown',
    config TEXT NOT NULL DEFAULT '{}')`,

  `CREATE TABLE IF NOT EXISTS webhook_endpoint (${COMMON},
    org_id TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '',
    secret_ref TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1)`,

  `CREATE TABLE IF NOT EXISTS webhook_delivery (${COMMON},
    endpoint_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    signature TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS api_key (${COMMON},
    org_id TEXT NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '', revoked_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS export_job (${COMMON},
    org_id TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued', requested_by TEXT NOT NULL, file_path TEXT,
    expires_at TEXT, error TEXT)`,

  `CREATE TABLE IF NOT EXISTS import_job (${COMMON},
    org_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'preview',
    total_rows INTEGER NOT NULL DEFAULT 0, valid_rows INTEGER NOT NULL DEFAULT 0,
    error_rows INTEGER NOT NULL DEFAULT 0, dry_run INTEGER NOT NULL DEFAULT 1,
    report TEXT NOT NULL DEFAULT '[]', requested_by TEXT NOT NULL, request_key TEXT)`,

  `CREATE TABLE IF NOT EXISTS retention_policy (${COMMON},
    org_id TEXT NOT NULL, module TEXT NOT NULL, retain_days INTEGER NOT NULL DEFAULT 1825,
    legal_hold INTEGER NOT NULL DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS idempotency_record (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, key TEXT NOT NULL, endpoint TEXT NOT NULL,
    response_body TEXT NOT NULL, status_code INTEGER NOT NULL DEFAULT 200, created_at TEXT NOT NULL)`,
];

export const INDEXES = [
  `CREATE INDEX IF NOT EXISTS ix_membership_user ON membership(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS ix_membership_org ON membership(tenant_id, org_id)`,
  `CREATE INDEX IF NOT EXISTS ix_department_access ON department_access(tenant_id, org_id, department_id)`,
  `CREATE INDEX IF NOT EXISTS ix_session_fingerprint ON session_token(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS ix_audit_tenant_seq ON audit_event(tenant_id, seq)`,
  `CREATE INDEX IF NOT EXISTS ix_task_org ON task(tenant_id, org_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS ix_tx_org ON transaction_record(tenant_id, org_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS ix_tx_period ON transaction_record(tenant_id, org_id, occurred_on)`,
  `CREATE INDEX IF NOT EXISTS ix_doc_chunk_org ON document_chunk(tenant_id, org_id)`,
  `CREATE INDEX IF NOT EXISTS ix_vault_owner ON vault_note(tenant_id, owner_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS ix_notification_recipient ON notification(tenant_id, recipient_id)`,
];
