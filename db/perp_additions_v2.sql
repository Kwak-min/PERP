-- =====================================================================
-- PERP 스키마 확장 v2 (과업지시서 신규 요구사항 반영)
-- 대상: perp_main (PostgreSQL 18). perpadmin 으로 실행.
-- 전제: perp_schema.sql 이 이미 적용돼 있어야 함(common.* 함수/타입 사용).
-- 성격: 신규 스키마/테이블 추가 전용. 기존 48개 테이블은 변경하지 않음.
--       (예외: calendar.events 에 external_uid 컬럼 1개만 추가 - SIR-001)
-- =====================================================================

-- =====================================================================
-- [ai] AI Agent / LLM 설정              (SFR-001)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS ai;

-- LLM 연결 설정: OpenRouter(외부) / 로컬 LLM, 사용자가 유동적 전환
--   회사 공용(owner_id NULL) 또는 개인(owner_id 지정)
--   ※ API 키 원문은 DB 저장 금지 → 시크릿 매니저 참조값(api_key_ref)만
CREATE TABLE ai.llm_configs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      REFERENCES org.companies(id) ON DELETE CASCADE,
    owner_id     BIGINT      REFERENCES auth.users(id)    ON DELETE CASCADE,
    name         TEXT        NOT NULL,               -- 표시명
    provider     TEXT        NOT NULL,               -- openrouter/local/openai/anthropic ...
    model        TEXT        NOT NULL,               -- 모델명
    endpoint     TEXT,                               -- 로컬/커스텀 엔드포인트 URL
    is_local     BOOLEAN     NOT NULL DEFAULT false, -- 로컬 LLM(보안) 여부
    api_key_ref  TEXT,                               -- 시크릿 참조 키(원문 X)
    params       JSONB       NOT NULL DEFAULT '{}'::jsonb, -- temperature 등
    is_default   BOOLEAN     NOT NULL DEFAULT false,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_llm_configs_company ON ai.llm_configs(company_id);
CREATE INDEX idx_llm_configs_owner   ON ai.llm_configs(owner_id);
SELECT common.attach_updated_at('ai.llm_configs');

-- 에이전트 대화 세션
CREATE TABLE ai.agent_sessions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id       BIGINT      REFERENCES auth.users(id)    ON DELETE SET NULL,
    llm_config_id BIGINT      REFERENCES ai.llm_configs(id) ON DELETE SET NULL,
    context_type  TEXT,        -- calendar/project/accounting/general ...
    context_id    BIGINT,      -- 관련 엔터티 id(선택)
    title         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_sessions_user ON ai.agent_sessions(user_id);

-- 에이전트 메시지
CREATE TABLE ai.agent_messages (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id   BIGINT      NOT NULL REFERENCES ai.agent_sessions(id) ON DELETE CASCADE,
    role         TEXT        NOT NULL,   -- user/assistant/system/tool
    content      TEXT        NOT NULL,
    model        TEXT,
    tokens       INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_messages_session ON ai.agent_messages(session_id, created_at);

-- =====================================================================
-- [notes] 옵시디언형 개인 노트          (SFR-002)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS notes;

-- 사용자별 볼트
CREATE TABLE notes.vaults (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id    BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL DEFAULT 'My Vault',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, name)
);

-- md 노트 (폴더 구조 포함)
CREATE TABLE notes.notes (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id     BIGINT      NOT NULL REFERENCES notes.vaults(id) ON DELETE CASCADE,
    folder_path  TEXT        NOT NULL DEFAULT '/',    -- 옵시디언 폴더 경로
    title        TEXT        NOT NULL,
    content_md   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (vault_id, folder_path, title)
);
CREATE INDEX idx_notes_vault ON notes.notes(vault_id);
SELECT common.attach_updated_at('notes.notes');

-- 노트 간 링크(백링크)
CREATE TABLE notes.links (
    from_note_id BIGINT NOT NULL REFERENCES notes.notes(id) ON DELETE CASCADE,
    to_note_id   BIGINT NOT NULL REFERENCES notes.notes(id) ON DELETE CASCADE,
    PRIMARY KEY (from_note_id, to_note_id)
);

-- =====================================================================
-- [chat] 채팅 (+AI 호출)                (SFR-008)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS chat;

CREATE TABLE chat.rooms (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    name         TEXT,                             -- 그룹방 이름(1:1이면 NULL 가능)
    is_group     BOOLEAN     NOT NULL DEFAULT false,
    created_by   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_rooms_company ON chat.rooms(company_id);

CREATE TABLE chat.room_members (
    room_id      BIGINT      NOT NULL REFERENCES chat.rooms(id)  ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_at TIMESTAMPTZ,
    PRIMARY KEY (room_id, user_id)
);

-- 발신자: sender_id 있으면 사용자, is_ai=true 면 AI 응답
CREATE TABLE chat.messages (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id      BIGINT      NOT NULL REFERENCES chat.rooms(id)   ON DELETE CASCADE,
    sender_id    BIGINT      REFERENCES auth.users(id)            ON DELETE SET NULL,
    is_ai        BOOLEAN     NOT NULL DEFAULT false,
    content      TEXT        NOT NULL,
    file_id      BIGINT      REFERENCES files.objects(id)         ON DELETE SET NULL, -- 자료 전달
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_room ON chat.messages(room_id, created_at);

-- =====================================================================
-- [hr] 출석/퇴근                        (SFR-007)
-- =====================================================================
CREATE TABLE hr.attendances (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id       BIGINT      NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    work_date     DATE        NOT NULL,
    check_in_at   TIMESTAMPTZ,       -- 출석 버튼 시각
    check_out_at  TIMESTAMPTZ,       -- 퇴근 버튼 시각
    source        TEXT        NOT NULL DEFAULT 'button', -- button/auto/manual
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, work_date),
    CHECK (check_out_at IS NULL OR check_in_at IS NULL OR check_out_at >= check_in_at)
);
CREATE INDEX idx_attendances_company ON hr.attendances(company_id, work_date);

-- =====================================================================
-- [calendar] 구글 캘린더 연동            (SIR-001)
-- =====================================================================
CREATE TABLE calendar.external_accounts (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL DEFAULT 'google',
    account_email    TEXT,
    access_token_ref TEXT,        -- 시크릿 참조(원문 X)
    refresh_token_ref TEXT,
    sync_token       TEXT,        -- 증분 동기화 토큰
    expires_at       TIMESTAMPTZ,
    is_active        BOOLEAN     NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider, account_email)
);
SELECT common.attach_updated_at('calendar.external_accounts');

-- 외부(구글) 이벤트 중복 방지용 식별자 (기존 events 테이블에 컬럼 1개만 추가)
ALTER TABLE calendar.events ADD COLUMN IF NOT EXISTS external_uid TEXT;
CREATE INDEX IF NOT EXISTS idx_events_external_uid ON calendar.events(external_uid);

-- =====================================================================
-- [project] 관여 기간 이력(인적자원 비용) (SFR-006, SFR-009)
-- =====================================================================
CREATE TABLE project.assignments (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id     BIGINT      NOT NULL REFERENCES project.projects(id) ON DELETE CASCADE,
    user_id        BIGINT      NOT NULL REFERENCES auth.users(id)       ON DELETE CASCADE,
    role           TEXT        NOT NULL DEFAULT 'member',
    allocation_pct SMALLINT    NOT NULL DEFAULT 100 CHECK (allocation_pct BETWEEN 0 AND 100),
    started_on     DATE        NOT NULL,
    ended_on       DATE,        -- NULL = 진행중
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX idx_assignments_project ON project.assignments(project_id);
CREATE INDEX idx_assignments_user    ON project.assignments(user_id, started_on);

-- =====================================================================
-- 완료. 신규 스키마별 테이블 수 확인:
--   SELECT schemaname, count(*) FROM pg_tables
--   WHERE schemaname IN ('ai','notes','chat')
--   GROUP BY schemaname ORDER BY schemaname;
-- =====================================================================
