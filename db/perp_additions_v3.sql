-- =====================================================================
-- PERP 스키마 확장 v3 — [검토·승인 완료 / 실행 가능]
-- 대상: perp_db (PostgreSQL 18)
-- 전제: perp_schema.sql + perp_additions_v2.sql 가 이미 적용돼 있어야 함
--       (common.attach_updated_at / common.approval_status / common.visibility,
--        org.companies / auth.users / accounting.* / project.* 사용)
-- 성격: 신규 스키마/테이블 추가 전용. 기존 테이블은 변경하지 않음.
-- 안전장치: 재실행 안전을 위해 CREATE ... IF NOT EXISTS 사용.
--           (기존 v1/v2 파일은 IF NOT EXISTS 를 안 쓰지만, 이 확장은 반복 검토·부분적용
--            가능성을 고려해 방어적으로 작성함.)
-- 승인 결정 반영:
--   A. asset.reservations 동일 자산 시간 겹침 차단 EXCLUDE USING gist 추가
--      (project.space_reservations 와 동일 패턴).
--   B. accounting.dues_charges.target_user_id = ON DELETE SET NULL (청구 이력 보존, nullable).
--   C. automation.workflows.trigger_type 컬럼명 유지(예약어 회피).
--   D. project.tasks 신설 + checklist/comments/dependencies 를 tasks 에 연결.
--   E. notice.notifications 신설(범용 알림).
-- =====================================================================

-- EXCLUDE USING gist 에 필요(스칼라 = 연산자를 gist 인덱스에서 쓰기 위함).
-- perp_schema.sql 이 이미 생성하지만, 단독 실행 안전을 위해 방어적으로 재선언(멱등).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =====================================================================
-- 1) asset : 자산 관리 (신규 스키마)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS asset;

CREATE TABLE IF NOT EXISTS asset.assets (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    code         TEXT,                                   -- 자산 코드(선택)
    category     TEXT,                                   -- 분류
    status       TEXT        NOT NULL DEFAULT 'in_use'
                 CHECK (status IN ('in_use','stored','repair','disposed','lost')),
    assignee_id  BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,  -- 담당자
    location     TEXT,
    acquired_on  DATE,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, code)                            -- code NULL 은 PG 에서 중복 허용됨
);
CREATE INDEX IF NOT EXISTS idx_assets_company  ON asset.assets(company_id);
CREATE INDEX IF NOT EXISTS idx_assets_assignee ON asset.assets(assignee_id);
SELECT common.attach_updated_at('asset.assets');

CREATE TABLE IF NOT EXISTS asset.reservations (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id     BIGINT      NOT NULL REFERENCES asset.assets(id) ON DELETE CASCADE,
    reserved_by  BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    starts_at    TIMESTAMPTZ NOT NULL,
    ends_at      TIMESTAMPTZ NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'reserved'
                 CHECK (status IN ('reserved','checked_out','returned','cancelled')),
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    -- 승인 A: 동일 자산의 시간 겹침 대여 차단 (project.space_reservations 와 동일 패턴)
    CONSTRAINT no_overlap_asset EXCLUDE USING gist (
        asset_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
    )
);
CREATE INDEX IF NOT EXISTS idx_asset_res_asset ON asset.reservations(asset_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_asset_res_user  ON asset.reservations(reserved_by);

CREATE TABLE IF NOT EXISTS asset.history (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id     BIGINT      NOT NULL REFERENCES asset.assets(id) ON DELETE CASCADE,
    event_type   TEXT        NOT NULL,   -- created/assigned/moved/status_changed/disposed ...
    actor_id     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_history_asset ON asset.history(asset_id, created_at);

-- =====================================================================
-- 2) accounting : 예산 / 회비 / 정산 (기존 스키마에 테이블 추가)
-- =====================================================================
CREATE TABLE IF NOT EXISTS accounting.budgets (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    period_id    BIGINT      REFERENCES accounting.fiscal_periods(id) ON DELETE SET NULL,
    name         TEXT        NOT NULL,
    account_id   BIGINT      REFERENCES accounting.accounts(id) ON DELETE SET NULL,
    amount       NUMERIC(18,2) NOT NULL DEFAULT 0,   -- 편성액
    spent        NUMERIC(18,2) NOT NULL DEFAULT 0,   -- 집행액(캐시)
    status       TEXT        NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','active','closed')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budgets_company ON accounting.budgets(company_id);
CREATE INDEX IF NOT EXISTS idx_budgets_period  ON accounting.budgets(period_id);
CREATE INDEX IF NOT EXISTS idx_budgets_account ON accounting.budgets(account_id);
SELECT common.attach_updated_at('accounting.budgets');

CREATE TABLE IF NOT EXISTS accounting.dues_rules (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    amount       NUMERIC(18,2) NOT NULL DEFAULT 0,
    cycle        TEXT        NOT NULL DEFAULT 'monthly'
                 CHECK (cycle IN ('once','monthly','quarterly','yearly')),
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dues_rules_company ON accounting.dues_rules(company_id);
SELECT common.attach_updated_at('accounting.dues_rules');

CREATE TABLE IF NOT EXISTS accounting.dues_charges (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    rule_id        BIGINT      REFERENCES accounting.dues_rules(id) ON DELETE SET NULL,
    target_user_id BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,  -- 승인 B: 대상자 삭제해도 청구 이력 보존(nullable)
    amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
    due_date       DATE,
    status         TEXT        NOT NULL DEFAULT 'unpaid'
                   CHECK (status IN ('unpaid','partial','paid','waived','overdue')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dues_charges_company ON accounting.dues_charges(company_id);
CREATE INDEX IF NOT EXISTS idx_dues_charges_rule    ON accounting.dues_charges(rule_id);
CREATE INDEX IF NOT EXISTS idx_dues_charges_target  ON accounting.dues_charges(target_user_id);

CREATE TABLE IF NOT EXISTS accounting.dues_payments (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    charge_id    BIGINT      NOT NULL REFERENCES accounting.dues_charges(id) ON DELETE CASCADE,
    paid_on      DATE        NOT NULL DEFAULT CURRENT_DATE,
    amount       NUMERIC(18,2) NOT NULL DEFAULT 0,
    method       TEXT,       -- cash/transfer/card ...
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dues_payments_charge ON accounting.dues_payments(charge_id);

CREATE TABLE IF NOT EXISTS accounting.settlements (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    requester_id     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    title            TEXT        NOT NULL,
    amount           NUMERIC(18,2) NOT NULL DEFAULT 0,
    status           common.approval_status NOT NULL DEFAULT 'pending',  -- enum 재사용
    decided_by       BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMPTZ,
    journal_entry_id BIGINT      REFERENCES accounting.journal_entries(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlements_company   ON accounting.settlements(company_id, status);
CREATE INDEX IF NOT EXISTS idx_settlements_requester ON accounting.settlements(requester_id);
SELECT common.attach_updated_at('accounting.settlements');

-- =====================================================================
-- 3) automation : 워크플로 자동화 (신규 스키마)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS automation;

CREATE TABLE IF NOT EXISTS automation.workflows (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    trigger_type TEXT        NOT NULL,   -- 승인 C: 'trigger' 는 SQL 예약어라 trigger_type 사용
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    definition   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_by   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflows_company ON automation.workflows(company_id);
SELECT common.attach_updated_at('automation.workflows');

CREATE TABLE IF NOT EXISTS automation.workflow_runs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id  BIGINT      NOT NULL REFERENCES automation.workflows(id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','succeeded','failed','cancelled')),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at     TIMESTAMPTZ,
    error        TEXT,
    log          JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON automation.workflow_runs(workflow_id, started_at);

-- =====================================================================
-- 4) ai : 에이전트 메모리 / 템플릿 (기존 스키마에 테이블 추가)
--    company_id 는 기존 ai.llm_configs 관례에 맞춰 NULL 허용(회사 공용 가능).
-- =====================================================================
CREATE TABLE IF NOT EXISTS ai.agent_memory (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id      BIGINT      REFERENCES auth.users(id) ON DELETE CASCADE,
    key          TEXT        NOT NULL,
    value        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_user ON ai.agent_memory(user_id);
SELECT common.attach_updated_at('ai.agent_memory');

CREATE TABLE IF NOT EXISTS ai.agent_templates (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    prompt       TEXT        NOT NULL,
    created_by   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_templates_company ON ai.agent_templates(company_id);
SELECT common.attach_updated_at('ai.agent_templates');

-- =====================================================================
-- 5) project : 마일스톤 / 업무(tasks) / 체크리스트 / 댓글 / 의존
--    ★ 설계 판단(승인 D): 현행 "업무"=project.assignments 는 사람의 프로젝트 배정
--      (allocation_pct, 기간)이라 "작업 단위"가 아님. 체크리스트/댓글/의존을
--      assignments 에 직접 붙이면 의미가 어긋남(한 사람이 여러 작업, 한 작업에 여러 사람).
--      => 별도 project.tasks(작업 단위) 신설을 권고하고, 하위 3테이블을 tasks 에 연결.
--         (원 브리핑의 assignment_id 참조안은 아래 "검토 노트 D" 에 대안으로 기술)
-- =====================================================================
CREATE TABLE IF NOT EXISTS project.milestones (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   BIGINT      NOT NULL REFERENCES project.projects(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    due_on       DATE,
    status       TEXT        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','done','cancelled')),
    sort_order   INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON project.milestones(project_id, sort_order);
SELECT common.attach_updated_at('project.milestones');

CREATE TABLE IF NOT EXISTS project.tasks (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    BIGINT      NOT NULL REFERENCES project.projects(id)   ON DELETE CASCADE,
    milestone_id  BIGINT      REFERENCES project.milestones(id)          ON DELETE SET NULL,
    assignment_id BIGINT      REFERENCES project.assignments(id)         ON DELETE SET NULL, -- 어떤 배정에서 파생됐는지(선택)
    assignee_id   BIGINT      REFERENCES auth.users(id)                  ON DELETE SET NULL, -- 담당자(단일)
    title         TEXT        NOT NULL,
    description   TEXT,
    status        TEXT        NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo','in_progress','done','blocked','cancelled')),
    due_on        DATE,
    sort_order    INTEGER     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project    ON project.tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee   ON project.tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone  ON project.tasks(milestone_id);
SELECT common.attach_updated_at('project.tasks');

CREATE TABLE IF NOT EXISTS project.task_checklist_items (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id      BIGINT      NOT NULL REFERENCES project.tasks(id) ON DELETE CASCADE,
    title        TEXT        NOT NULL,
    done         BOOLEAN     NOT NULL DEFAULT false,
    sort_order   INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_task ON project.task_checklist_items(task_id, sort_order);

CREATE TABLE IF NOT EXISTS project.task_comments (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id      BIGINT      NOT NULL REFERENCES project.tasks(id) ON DELETE CASCADE,
    author_id    BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    body         TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON project.task_comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS project.task_dependencies (
    task_id       BIGINT NOT NULL REFERENCES project.tasks(id) ON DELETE CASCADE,
    depends_on_id BIGINT NOT NULL REFERENCES project.tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_id),
    CHECK (task_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON project.task_dependencies(depends_on_id);

-- =====================================================================
-- 6) notice.notifications : 범용 알림 (NOT-001)
--    권고: report.notifications(리포트 전용, company_id 없음)를 재사용하지 말고
--          notice 스키마에 범용 알림 테이블을 신설. (승인 E)
--    스키마가 달라(notice vs report) 이름 충돌 없음. (승인 E)
-- =====================================================================
CREATE TABLE IF NOT EXISTS notice.notifications (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    kind         TEXT        NOT NULL,   -- 알림 유형(모듈/이벤트)
    title        TEXT        NOT NULL,
    body         TEXT,
    link         TEXT,
    is_read      BOOLEAN     NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notice_notif_user_unread
    ON notice.notifications(user_id) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS idx_notice_notif_company ON notice.notifications(company_id, created_at DESC);

-- =====================================================================
-- 완료. 적용 후 확인용:
--   SELECT schemaname, count(*) FROM pg_tables
--     WHERE schemaname IN ('asset','automation','ai','accounting','project','notice')
--     GROUP BY schemaname ORDER BY schemaname;
-- =====================================================================
