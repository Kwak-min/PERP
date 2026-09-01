-- =====================================================================
-- PERP 전체 스키마 (단일 파일, 실행 순서 정리됨)
-- 대상: PostgreSQL 18 / DB = perp_db
-- 실행: DataGrip 에서 perp_db 에 접속한 뒤 이 파일 전체를 Run
--       (또는  psql -d perp_db -f perp_schema.sql)
-- 전제: 먼저 CREATE DATABASE perp_db; 로 DB 를 만들어 두고 그 DB 에서 실행.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) 확장 (공간 예약 겹침 방지에 필요)
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------
-- 1) 도메인 스키마
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS common;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS org;
CREATE SCHEMA IF NOT EXISTS report;
CREATE SCHEMA IF NOT EXISTS notice;
CREATE SCHEMA IF NOT EXISTS calendar;
CREATE SCHEMA IF NOT EXISTS accounting;
CREATE SCHEMA IF NOT EXISTS hr;
CREATE SCHEMA IF NOT EXISTS project;
CREATE SCHEMA IF NOT EXISTS files;

-- ---------------------------------------------------------------------
-- 2) 공용 enum + 트리거 함수
-- ---------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE common.approval_status AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE common.account_status AS ENUM ('active','suspended','withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE common.visibility AS ENUM ('private','team','department','company');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION common.set_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION common.attach_updated_at(p_table regclass)
RETURNS void AS $$
BEGIN
    EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %s
             FOR EACH ROW EXECUTE FUNCTION common.set_updated_at()', p_table::text);
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 3) org 기본: 회사 / 부서 / 직급 / 워크스페이스
-- ---------------------------------------------------------------------
CREATE TABLE org.companies (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT        NOT NULL,
    biz_reg_no   TEXT,
    ceo_name     TEXT,
    address      TEXT,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org.departments (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    parent_id      BIGINT      REFERENCES org.departments(id) ON DELETE SET NULL,
    name           TEXT        NOT NULL,
    code           TEXT,
    manager_id     BIGINT,     -- auth.users FK 는 아래 auth 생성 후 ALTER 로 연결
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);
CREATE INDEX idx_departments_company ON org.departments(company_id);
CREATE INDEX idx_departments_parent  ON org.departments(parent_id);

CREATE TABLE org.positions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    rank_level   SMALLINT    NOT NULL,   -- 클수록 상위 직급
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, name),
    UNIQUE (company_id, rank_level)
);

CREATE TABLE org.workspaces (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    kind         TEXT        NOT NULL DEFAULT 'general',
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);
CREATE INDEX idx_workspaces_company ON org.workspaces(company_id);

SELECT common.attach_updated_at('org.companies');
SELECT common.attach_updated_at('org.departments');
SELECT common.attach_updated_at('org.workspaces');

-- ---------------------------------------------------------------------
-- 4) auth: 사용자 / 세션 / 로그인 로그
-- ---------------------------------------------------------------------
CREATE TABLE auth.users (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT      REFERENCES org.companies(id)   ON DELETE SET NULL,
    department_id  BIGINT      REFERENCES org.departments(id) ON DELETE SET NULL,
    position_id    BIGINT      REFERENCES org.positions(id)   ON DELETE SET NULL,
    email          TEXT        NOT NULL,
    name           TEXT        NOT NULL,
    phone          TEXT,
    password_hash  TEXT        NOT NULL,
    account_status   common.account_status  NOT NULL DEFAULT 'active',
    approval_status  common.approval_status NOT NULL DEFAULT 'pending',
    approved_by      BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at      TIMESTAMPTZ,
    is_admin         BOOLEAN     NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email_lower ON auth.users (lower(email));
CREATE INDEX idx_users_company    ON auth.users(company_id);
CREATE INDEX idx_users_department ON auth.users(department_id);
CREATE INDEX idx_users_approval   ON auth.users(approval_status);
SELECT common.attach_updated_at('auth.users');

ALTER TABLE org.departments
    ADD CONSTRAINT fk_departments_manager
    FOREIGN KEY (manager_id) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE auth.sessions (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_token  UUID        NOT NULL DEFAULT gen_random_uuid(),
    login_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    logout_at      TIMESTAMPTZ,
    ip_address     INET,
    user_agent     TEXT,
    is_active      BOOLEAN     NOT NULL DEFAULT true,
    UNIQUE (session_token)
);
CREATE INDEX idx_sessions_user   ON auth.sessions(user_id);
CREATE INDEX idx_sessions_active ON auth.sessions(user_id) WHERE is_active;

CREATE TABLE auth.login_logs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    email_tried  TEXT        NOT NULL,
    success      BOOLEAN     NOT NULL,
    reason       TEXT,
    ip_address   INET,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_logs_user ON auth.login_logs(user_id);
CREATE INDEX idx_login_logs_time ON auth.login_logs(created_at);

-- ---------------------------------------------------------------------
-- 5) org RBAC: 팀 / 역할 / 권한 / 승인요청
-- ---------------------------------------------------------------------
CREATE TABLE org.teams (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT      NOT NULL REFERENCES org.companies(id)   ON DELETE CASCADE,
    department_id  BIGINT      REFERENCES org.departments(id)          ON DELETE SET NULL,
    name           TEXT        NOT NULL,
    leader_id      BIGINT      REFERENCES auth.users(id)               ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);
CREATE INDEX idx_teams_department ON org.teams(department_id);
SELECT common.attach_updated_at('org.teams');

CREATE TABLE org.team_members (
    team_id      BIGINT      NOT NULL REFERENCES org.teams(id)  ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    team_role    TEXT        NOT NULL DEFAULT 'member',
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON org.team_members(user_id);

CREATE TABLE org.permissions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         TEXT        NOT NULL UNIQUE,
    module       TEXT        NOT NULL,
    description  TEXT
);

CREATE TABLE org.roles (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    is_system    BOOLEAN     NOT NULL DEFAULT false,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);

CREATE TABLE org.role_permissions (
    role_id        BIGINT NOT NULL REFERENCES org.roles(id)       ON DELETE CASCADE,
    permission_id  BIGINT NOT NULL REFERENCES org.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE org.user_roles (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
    role_id       BIGINT      NOT NULL REFERENCES org.roles(id)       ON DELETE CASCADE,
    workspace_id  BIGINT      REFERENCES org.workspaces(id)           ON DELETE CASCADE,
    granted_by    BIGINT      REFERENCES auth.users(id)               ON DELETE SET NULL,
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, role_id, workspace_id)
);
CREATE INDEX idx_user_roles_user ON org.user_roles(user_id);
CREATE INDEX idx_user_roles_ws   ON org.user_roles(workspace_id);

CREATE TABLE org.approval_requests (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    request_type   TEXT        NOT NULL,
    requester_id   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    target_user_id BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status         common.approval_status NOT NULL DEFAULT 'pending',
    decided_by     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    decided_at     TIMESTAMPTZ,
    decision_note  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_status ON org.approval_requests(company_id, status);

-- ---------------------------------------------------------------------
-- 6) files: 오브젝트 스토리지 메타 / 외부연동
-- ---------------------------------------------------------------------
CREATE TABLE files.objects (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    uploader_id    BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    original_name  TEXT        NOT NULL,
    extension      TEXT        NOT NULL,
    mime_type      TEXT,
    size_bytes     BIGINT      NOT NULL DEFAULT 0,
    checksum_sha256 TEXT,
    storage_bucket TEXT        NOT NULL,
    storage_key    TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (storage_bucket, storage_key)
);
CREATE INDEX idx_files_company  ON files.objects(company_id);
CREATE INDEX idx_files_uploader ON files.objects(uploader_id);
CREATE INDEX idx_files_ext      ON files.objects(extension);

CREATE TABLE files.integrations (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    provider     TEXT        NOT NULL,
    name         TEXT        NOT NULL,
    config       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, provider, name)
);
SELECT common.attach_updated_at('files.integrations');

-- ---------------------------------------------------------------------
-- 7) report: 보고 스택
-- ---------------------------------------------------------------------
CREATE TABLE report.threads (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    title        TEXT        NOT NULL,
    created_by   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    status       TEXT        NOT NULL DEFAULT 'open',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_report_threads_company ON report.threads(company_id);
SELECT common.attach_updated_at('report.threads');

CREATE TABLE report.items (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id    BIGINT      NOT NULL REFERENCES report.threads(id) ON DELETE CASCADE,
    seq          INTEGER     NOT NULL,
    sender_id    BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    action       TEXT        NOT NULL DEFAULT 'submit',
    body         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (thread_id, seq)
);
CREATE INDEX idx_report_items_thread ON report.items(thread_id);

CREATE TABLE report.recipients (
    item_id      BIGINT      NOT NULL REFERENCES report.items(id) ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
    read_at      TIMESTAMPTZ,
    PRIMARY KEY (item_id, user_id)
);
CREATE INDEX idx_report_recipients_user ON report.recipients(user_id);

CREATE TABLE report.item_files (
    item_id      BIGINT NOT NULL REFERENCES report.items(id)   ON DELETE CASCADE,
    file_id      BIGINT NOT NULL REFERENCES files.objects(id)  ON DELETE RESTRICT,
    PRIMARY KEY (item_id, file_id)
);

CREATE TABLE report.notifications (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    kind         TEXT        NOT NULL,
    title        TEXT        NOT NULL,
    body         TEXT,
    link         TEXT,
    is_read      BOOLEAN     NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at      TIMESTAMPTZ
);
CREATE INDEX idx_notifications_user_unread ON report.notifications(user_id) WHERE NOT is_read;

-- ---------------------------------------------------------------------
-- 8) notice: 공지/공문
-- ---------------------------------------------------------------------
CREATE TABLE notice.notices (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    author_id     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    title         TEXT        NOT NULL,
    body          TEXT,
    is_official   BOOLEAN     NOT NULL DEFAULT false,
    visibility    common.visibility NOT NULL DEFAULT 'company',
    department_id BIGINT      REFERENCES org.departments(id) ON DELETE CASCADE,
    team_id       BIGINT      REFERENCES org.teams(id)       ON DELETE CASCADE,
    pinned        BOOLEAN     NOT NULL DEFAULT false,
    published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notices_company ON notice.notices(company_id, published_at DESC);
SELECT common.attach_updated_at('notice.notices');

CREATE TABLE notice.notice_files (
    notice_id  BIGINT NOT NULL REFERENCES notice.notices(id) ON DELETE CASCADE,
    file_id    BIGINT NOT NULL REFERENCES files.objects(id)  ON DELETE RESTRICT,
    PRIMARY KEY (notice_id, file_id)
);

CREATE TABLE notice.notice_reads (
    notice_id  BIGINT      NOT NULL REFERENCES notice.notices(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES auth.users(id)     ON DELETE CASCADE,
    read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (notice_id, user_id)
);

-- ---------------------------------------------------------------------
-- 9) calendar: 일정 + 직급 가시성 함수
-- ---------------------------------------------------------------------
CREATE TABLE calendar.events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    owner_id      BIGINT      NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    title         TEXT        NOT NULL,
    description   TEXT,
    location      TEXT,
    starts_at     TIMESTAMPTZ NOT NULL,
    ends_at       TIMESTAMPTZ NOT NULL,
    all_day       BOOLEAN     NOT NULL DEFAULT false,
    scope         common.visibility NOT NULL DEFAULT 'private',
    department_id BIGINT      REFERENCES org.departments(id) ON DELETE SET NULL,
    team_id       BIGINT      REFERENCES org.teams(id)       ON DELETE SET NULL,
    source_type   TEXT,
    source_id     BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at >= starts_at)
);
CREATE INDEX idx_events_owner   ON calendar.events(owner_id);
CREATE INDEX idx_events_company ON calendar.events(company_id, starts_at);
CREATE INDEX idx_events_dept    ON calendar.events(department_id);
CREATE INDEX idx_events_team    ON calendar.events(team_id);
SELECT common.attach_updated_at('calendar.events');

CREATE TABLE calendar.event_participants (
    event_id   BIGINT NOT NULL REFERENCES calendar.events(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
    response   TEXT   NOT NULL DEFAULT 'invited',
    PRIMARY KEY (event_id, user_id)
);

CREATE OR REPLACE FUNCTION calendar.can_view_schedule(p_viewer BIGINT, p_owner BIGINT)
RETURNS boolean AS $$
DECLARE
    v_company BIGINT; v_dept BIGINT; v_rank SMALLINT;
    o_company BIGINT; o_dept BIGINT; o_rank SMALLINT;
BEGIN
    IF p_viewer = p_owner THEN RETURN true; END IF;
    SELECT u.company_id, u.department_id, p.rank_level INTO v_company, v_dept, v_rank
      FROM auth.users u LEFT JOIN org.positions p ON p.id = u.position_id WHERE u.id = p_viewer;
    SELECT u.company_id, u.department_id, p.rank_level INTO o_company, o_dept, o_rank
      FROM auth.users u LEFT JOIN org.positions p ON p.id = u.position_id WHERE u.id = p_owner;
    IF v_company IS NULL OR v_company <> o_company THEN RETURN false; END IF;
    IF v_dept IS NULL OR v_dept <> o_dept THEN RETURN false; END IF;
    RETURN COALESCE(v_rank,0) >= COALESCE(o_rank,0);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- 10) accounting: 회계
-- ---------------------------------------------------------------------
CREATE TABLE accounting.fiscal_periods (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    starts_on    DATE        NOT NULL,
    ends_on      DATE        NOT NULL,
    is_closed    BOOLEAN     NOT NULL DEFAULT false,
    UNIQUE (company_id, name),
    CHECK (ends_on >= starts_on)
);

CREATE TABLE accounting.accounts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    code         TEXT        NOT NULL,
    name         TEXT        NOT NULL,
    account_type TEXT        NOT NULL,
    parent_id    BIGINT      REFERENCES accounting.accounts(id) ON DELETE SET NULL,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    UNIQUE (company_id, code),
    CHECK (account_type IN ('asset','liability','equity','revenue','expense'))
);

CREATE TABLE accounting.journal_entries (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    period_id    BIGINT      REFERENCES accounting.fiscal_periods(id) ON DELETE SET NULL,
    entry_date   DATE        NOT NULL,
    memo         TEXT,
    created_by   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    posted       BOOLEAN     NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_journal_company ON accounting.journal_entries(company_id, entry_date);

CREATE TABLE accounting.journal_lines (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id     BIGINT       NOT NULL REFERENCES accounting.journal_entries(id) ON DELETE CASCADE,
    account_id   BIGINT       NOT NULL REFERENCES accounting.accounts(id),
    debit        NUMERIC(18,2) NOT NULL DEFAULT 0,
    credit       NUMERIC(18,2) NOT NULL DEFAULT 0,
    description  TEXT,
    department_id BIGINT      REFERENCES org.departments(id) ON DELETE SET NULL,
    CHECK (debit >= 0 AND credit >= 0),
    CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_journal_lines_entry   ON accounting.journal_lines(entry_id);
CREATE INDEX idx_journal_lines_account ON accounting.journal_lines(account_id);

CREATE TABLE accounting.financial_statements (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT     NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    period_id     BIGINT     NOT NULL REFERENCES accounting.fiscal_periods(id) ON DELETE CASCADE,
    statement_type TEXT      NOT NULL,
    data          JSONB      NOT NULL DEFAULT '{}'::jsonb,
    generated_by  BIGINT     REFERENCES auth.users(id) ON DELETE SET NULL,
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, period_id, statement_type)
);

CREATE TABLE accounting.tax_filings (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    period_id    BIGINT      REFERENCES accounting.fiscal_periods(id) ON DELETE SET NULL,
    tax_type     TEXT        NOT NULL,
    amount       NUMERIC(18,2) NOT NULL DEFAULT 0,
    due_date     DATE,
    filed_at     TIMESTAMPTZ,
    status       TEXT        NOT NULL DEFAULT 'draft',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounting.internal_controls (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    control_name TEXT        NOT NULL,
    category     TEXT,
    frequency    TEXT,
    owner_id     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    last_checked TIMESTAMPTZ,
    result       TEXT,
    note         TEXT
);

-- ---------------------------------------------------------------------
-- 11) hr: 인사
-- ---------------------------------------------------------------------
CREATE TABLE hr.leave_requests (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    leave_type   TEXT        NOT NULL,
    starts_on    DATE        NOT NULL,
    ends_on      DATE        NOT NULL,
    days         NUMERIC(4,1) NOT NULL DEFAULT 1,
    reason       TEXT,
    status       common.approval_status NOT NULL DEFAULT 'pending',
    approver_id  BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    decided_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_on >= starts_on)
);
CREATE INDEX idx_leave_user ON hr.leave_requests(user_id, starts_on);

CREATE TABLE hr.leave_balances (
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    year         SMALLINT    NOT NULL,
    total_days   NUMERIC(4,1) NOT NULL DEFAULT 0,
    used_days    NUMERIC(4,1) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, year)
);

CREATE TABLE hr.job_postings (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT     NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    department_id BIGINT     REFERENCES org.departments(id) ON DELETE SET NULL,
    title         TEXT       NOT NULL,
    description   TEXT,
    headcount     SMALLINT   NOT NULL DEFAULT 1,
    status        TEXT       NOT NULL DEFAULT 'open',
    opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ
);

CREATE TABLE hr.applicants (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    posting_id    BIGINT     NOT NULL REFERENCES hr.job_postings(id) ON DELETE CASCADE,
    name          TEXT       NOT NULL,
    email         TEXT,
    phone         TEXT,
    resume_file_id BIGINT    REFERENCES files.objects(id) ON DELETE SET NULL,
    stage         TEXT       NOT NULL DEFAULT 'applied',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_applicants_posting ON hr.applicants(posting_id, stage);

CREATE TABLE hr.employment_events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT     NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id       BIGINT     NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    event_type    TEXT       NOT NULL,
    effective_date DATE      NOT NULL,
    from_position_id   BIGINT REFERENCES org.positions(id)   ON DELETE SET NULL,
    to_position_id     BIGINT REFERENCES org.positions(id)   ON DELETE SET NULL,
    from_department_id BIGINT REFERENCES org.departments(id) ON DELETE SET NULL,
    to_department_id   BIGINT REFERENCES org.departments(id) ON DELETE SET NULL,
    reason        TEXT,
    processed_by  BIGINT     REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employment_events_user ON hr.employment_events(user_id, effective_date);

CREATE TABLE hr.payrolls (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id       BIGINT      NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    pay_year      SMALLINT    NOT NULL,
    pay_month     SMALLINT    NOT NULL CHECK (pay_month BETWEEN 1 AND 12),
    base_salary   NUMERIC(18,2) NOT NULL DEFAULT 0,
    allowances    NUMERIC(18,2) NOT NULL DEFAULT 0,
    deductions    NUMERIC(18,2) NOT NULL DEFAULT 0,
    net_pay       NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, pay_year, pay_month)
);
CREATE INDEX idx_payrolls_company ON hr.payrolls(company_id, pay_year, pay_month);

-- ---------------------------------------------------------------------
-- 12) project: 프로젝트 관리
-- ---------------------------------------------------------------------
CREATE TABLE project.projects (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id)   ON DELETE CASCADE,
    department_id BIGINT      REFERENCES org.departments(id)          ON DELETE SET NULL,
    team_id       BIGINT      REFERENCES org.teams(id)                ON DELETE SET NULL,
    name          TEXT        NOT NULL,
    description   TEXT,
    status        TEXT        NOT NULL DEFAULT 'active',
    starts_on     DATE,
    ends_on       DATE,
    lead_id       BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_company ON project.projects(company_id, status);
SELECT common.attach_updated_at('project.projects');

CREATE TABLE project.project_members (
    project_id  BIGINT NOT NULL REFERENCES project.projects(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES auth.users(id)       ON DELETE CASCADE,
    role        TEXT   NOT NULL DEFAULT 'member',
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project.documents (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    BIGINT      NOT NULL REFERENCES project.projects(id) ON DELETE CASCADE,
    title         TEXT        NOT NULL,
    content_md    TEXT,
    file_id       BIGINT      REFERENCES files.objects(id) ON DELETE SET NULL,
    author_id     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    version       INTEGER     NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_project ON project.documents(project_id);
SELECT common.attach_updated_at('project.documents');

CREATE TABLE project.meeting_minutes (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    BIGINT      REFERENCES project.projects(id) ON DELETE CASCADE,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    title         TEXT        NOT NULL,
    meeting_at    TIMESTAMPTZ NOT NULL,
    location      TEXT,
    content_md    TEXT,
    author_id     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_minutes_project ON project.meeting_minutes(project_id, meeting_at);

CREATE TABLE project.meeting_attendees (
    minute_id  BIGINT NOT NULL REFERENCES project.meeting_minutes(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES auth.users(id)              ON DELETE CASCADE,
    PRIMARY KEY (minute_id, user_id)
);

CREATE TABLE project.handover_chats (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    BIGINT      REFERENCES project.projects(id) ON DELETE CASCADE,
    user_id       BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    title         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project.handover_messages (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chat_id       BIGINT      NOT NULL REFERENCES project.handover_chats(id) ON DELETE CASCADE,
    role          TEXT        NOT NULL,
    content       TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_handover_msgs_chat ON project.handover_messages(chat_id, created_at);

CREATE TABLE project.spaces (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    capacity      SMALLINT,
    location      TEXT,
    is_active     BOOLEAN     NOT NULL DEFAULT true,
    UNIQUE (company_id, name)
);

CREATE TABLE project.space_reservations (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    space_id      BIGINT      NOT NULL REFERENCES project.spaces(id) ON DELETE CASCADE,
    reserved_by   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    project_id    BIGINT      REFERENCES project.projects(id) ON DELETE SET NULL,
    title         TEXT,
    starts_at     TIMESTAMPTZ NOT NULL,
    ends_at       TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    CONSTRAINT no_overlap_space EXCLUDE USING gist (
        space_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
    )
);
CREATE INDEX idx_space_res_space ON project.space_reservations(space_id, starts_at);

-- =====================================================================
-- 완료. 스키마별 테이블 수 확인:
--   SELECT schemaname, count(*) FROM pg_tables
--   WHERE schemaname IN ('auth','org','report','notice','calendar',
--                        'accounting','hr','project','files')
--   GROUP BY schemaname ORDER BY schemaname;
-- =====================================================================
