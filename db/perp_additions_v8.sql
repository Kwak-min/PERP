-- =====================================================================
-- PERP 스키마 확장 v8 (신규 6개 테이블 + 마이그레이션 이력)
-- 대상: perp_db (PostgreSQL 18). v1~v7 적용 이후 수동 실행.
-- 성격: 신규 테이블 추가 전용. 기존 테이블 변경 없음.
-- ★ 부팅 시 자동실행 안 함. 승인된 환경에 명시적으로 적용.
--
-- 참조 대상은 v1~v7 기준 실제 정의로 검증 완료:
--   common.approval_status(enum)          - perp_schema.sql
--   common.attach_updated_at(regclass)    - perp_schema.sql
--   org.companies / org.departments /
--   org.positions / auth.users            - perp_schema.sql
--   project.projects                      - perp_schema.sql
--   hr.attendances(id BIGINT PK)          - perp_additions_v2.sql
--   common.schema_migrations              - 미존재 → 본 파일에서 신설
--
-- 사용된 PG15+ 문법: UNIQUE NULLS NOT DISTINCT (org.home_layouts).
--   대상 PG18 에서 정상 동작. (NULL 조합을 중복으로 취급하여
--   company/department/project 스코프 조합의 유일성 보장)
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS common.schema_migrations (
    version     TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    note        TEXT
);

-- 1) org.department_access_roles (부서 ↔ role_key N:N; role_key FK 아님)
CREATE TABLE org.department_access_roles (
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id)   ON DELETE CASCADE,
    department_id BIGINT      NOT NULL REFERENCES org.departments(id) ON DELETE CASCADE,
    role_key      TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (department_id, role_key)
);
CREATE INDEX idx_dept_access_company ON org.department_access_roles(company_id);

-- 2) org.home_layouts (회사 + 선택 부서 + 선택 프로젝트 스코프)
CREATE TABLE org.home_layouts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id)   ON DELETE CASCADE,
    department_id BIGINT      REFERENCES org.departments(id)          ON DELETE CASCADE,
    project_id    BIGINT      REFERENCES project.projects(id)         ON DELETE CASCADE,
    blocks        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    updated_by    BIGINT      REFERENCES auth.users(id)               ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (company_id, department_id, project_id)
);
SELECT common.attach_updated_at('org.home_layouts');

-- 3) hr.attendance_corrections (본인 신청)
CREATE TABLE hr.attendance_corrections (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT       NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id       BIGINT       NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    attendance_id BIGINT       REFERENCES hr.attendances(id)         ON DELETE SET NULL,
    work_date     DATE         NOT NULL,
    kind          TEXT         NOT NULL,
    hours         NUMERIC(4,1) NOT NULL DEFAULT 0 CHECK (hours >= 0 AND hours <= 24),
    note          TEXT,
    status        common.approval_status NOT NULL DEFAULT 'pending',
    decided_by    BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL,
    decided_at    TIMESTAMPTZ,
    comment       TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_att_corr_company_status ON hr.attendance_corrections(company_id, status);
CREATE INDEX idx_att_corr_user           ON hr.attendance_corrections(user_id, work_date);
SELECT common.attach_updated_at('hr.attendance_corrections');

-- 4) hr.leave_policies (회사+종류별 1행)
CREATE TABLE hr.leave_policies (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT       NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    kind               TEXT         NOT NULL,
    default_days       NUMERIC(4,1) NOT NULL DEFAULT 0 CHECK (default_days >= 0),
    carryover_enabled  BOOLEAN      NOT NULL DEFAULT false,
    carryover_max_days NUMERIC(4,1) NOT NULL DEFAULT 0 CHECK (carryover_max_days >= 0),
    expiry_note        TEXT         NOT NULL DEFAULT '',
    updated_by         BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (company_id, kind)
);
SELECT common.attach_updated_at('hr.leave_policies');

-- 5) hr.onboarding_tasks (온보딩/오프보딩 체크리스트)
CREATE TABLE hr.onboarding_tasks (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id  BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
    flow        TEXT        NOT NULL DEFAULT 'onboarding' CHECK (flow IN ('onboarding','offboarding')),
    label       TEXT        NOT NULL,
    seq         INTEGER     NOT NULL DEFAULT 0,
    done        BOOLEAN     NOT NULL DEFAULT false,
    done_at     TIMESTAMPTZ,
    done_by     BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_onboarding_member  ON hr.onboarding_tasks(user_id, flow);
CREATE INDEX idx_onboarding_company ON hr.onboarding_tasks(company_id);

-- 6) org.member_invites (초대 토큰/만료/상태/역할/부서)
CREATE TABLE org.member_invites (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT      NOT NULL REFERENCES org.companies(id)   ON DELETE CASCADE,
    email         TEXT        NOT NULL,
    token         UUID        NOT NULL DEFAULT gen_random_uuid(),
    roles         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    department_id BIGINT      REFERENCES org.departments(id)          ON DELETE SET NULL,
    position_id   BIGINT      REFERENCES org.positions(id)            ON DELETE SET NULL,
    status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
    invited_by    BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    accepted_by   BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
    accepted_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (token)
);
CREATE INDEX idx_member_invites_company ON org.member_invites(company_id, status);
CREATE INDEX idx_member_invites_email   ON org.member_invites(lower(email));
CREATE UNIQUE INDEX uq_member_invites_pending
    ON org.member_invites(company_id, lower(email)) WHERE status = 'pending';
SELECT common.attach_updated_at('org.member_invites');

INSERT INTO common.schema_migrations(version, note)
VALUES ('v8', '6 new tables: department_access_roles, home_layouts, attendance_corrections, leave_policies, onboarding_tasks, member_invites')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- =====================================================================
-- [참고] v1~v7 은 schema_migrations 에 소급 백필하지 않는다 (승인 결정 #5).
--        이 이력 테이블은 v8 부터 관리 시작.
-- =====================================================================

-- =====================================================================
-- [적용 전] 선행 확인 쿼리 (실행 X, 수동 점검용)
-- ---------------------------------------------------------------------
-- (A) 신규 6개 테이블이 아직 없어야 함 (결과 0 행이 정상):
--   SELECT n.nspname AS schema, c.relname AS table
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE c.relkind = 'r'
--      AND (n.nspname, c.relname) IN (
--            ('org','department_access_roles'), ('org','home_layouts'),
--            ('hr','attendance_corrections'),   ('hr','leave_policies'),
--            ('hr','onboarding_tasks'),         ('org','member_invites'));
--
-- (B) 참조 대상이 모두 존재해야 함 (결과 8 행이 정상):
--   SELECT n.nspname||'.'||c.relname
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE (n.nspname, c.relname) IN (
--            ('org','companies'), ('org','departments'), ('org','positions'),
--            ('auth','users'), ('project','projects'), ('hr','attendances'),
--            ('common','schema_migrations'))    -- schema_migrations 는 미존재일 수 있음
--       OR (n.nspname='common');  -- 참고용
--   -- 함수/enum 존재 확인:
--   SELECT 'approval_status' WHERE EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='common' AND t.typname='approval_status');
--   SELECT 'attach_updated_at' WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='common' AND p.proname='attach_updated_at');
--
-- =====================================================================
-- [적용 후] 검증 쿼리 (실행 X)
-- ---------------------------------------------------------------------
-- (C) 6개 테이블 생성 확인 (결과 6 행):
--   SELECT n.nspname AS schema, c.relname AS table
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE c.relkind='r' AND (n.nspname, c.relname) IN (
--            ('org','department_access_roles'), ('org','home_layouts'),
--            ('hr','attendance_corrections'),   ('hr','leave_policies'),
--            ('hr','onboarding_tasks'),         ('org','member_invites'))
--    ORDER BY 1,2;
-- (D) 마이그레이션 이력:
--   SELECT * FROM common.schema_migrations WHERE version='v8';
-- (E) updated_at 트리거 부착 확인 (home_layouts/attendance_corrections/leave_policies/member_invites 4행):
--   SELECT relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
--    WHERE tgname='trg_set_updated_at'
--      AND relname IN ('home_layouts','attendance_corrections','leave_policies','member_invites');
-- (F) 개별 구조 확인 예:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema='org' AND table_name='member_invites' ORDER BY ordinal_position;
--
-- =====================================================================
-- [롤백] (실행 X — 되돌릴 때만 수동 실행)
-- ---------------------------------------------------------------------
--   BEGIN;
--   DROP TABLE IF EXISTS org.member_invites;
--   DROP TABLE IF EXISTS hr.onboarding_tasks;
--   DROP TABLE IF EXISTS hr.leave_policies;
--   DROP TABLE IF EXISTS hr.attendance_corrections;
--   DROP TABLE IF EXISTS org.home_layouts;
--   DROP TABLE IF EXISTS org.department_access_roles;
--   DELETE FROM common.schema_migrations WHERE version='v8';
--   -- 주의: common.schema_migrations 테이블 자체는 v8 이 만든 것이므로
--   --       완전 원복이 필요하면 아래도 함께 (다른 마이그레이션이 안 쓸 때만):
--   -- DROP TABLE IF EXISTS common.schema_migrations;
--   COMMIT;
-- =====================================================================
