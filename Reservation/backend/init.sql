-- ─────────────────────────────────────────────────
-- ERP 회의실 예약 시스템 DB 초기화 SQL
-- 대상: NCP Cloud DB for PostgreSQL
-- ─────────────────────────────────────────────────

-- (타팀 담당) 사용자 테이블 참조용 주석
-- CREATE TABLE IF NOT EXISTS users (
--     id          BIGSERIAL PRIMARY KEY,
--     email       VARCHAR(255) UNIQUE NOT NULL,
--     name        VARCHAR(100) NOT NULL,
--     department  VARCHAR(100),
--     role        VARCHAR(20) NOT NULL DEFAULT 'USER',
--     created_at  TIMESTAMP NOT NULL DEFAULT NOW()
-- );

-- Enum 타입
CREATE TYPE reservation_status    AS ENUM ('CONFIRMED', 'CANCELLED');
CREATE TYPE recurrence_frequency  AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE attendee_status       AS ENUM ('INVITED', 'ACCEPTED', 'DECLINED');

-- 공간 테이블
CREATE TABLE IF NOT EXISTS spaces (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    location    VARCHAR(200) NOT NULL,
    floor       VARCHAR(20),
    capacity    INTEGER NOT NULL CHECK (capacity > 0),
    amenities   JSONB,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 반복 규칙 테이블
CREATE TABLE IF NOT EXISTS recurrence_rules (
    id              BIGSERIAL PRIMARY KEY,
    frequency       recurrence_frequency NOT NULL,
    interval        INTEGER NOT NULL DEFAULT 1,
    days_of_week    JSONB,
    end_date        DATE,
    max_occurrences INTEGER
);

-- 예약 테이블
CREATE TABLE IF NOT EXISTS reservations (
    id                  BIGSERIAL PRIMARY KEY,
    space_id            BIGINT NOT NULL REFERENCES spaces(id),
    user_id             BIGINT NOT NULL,           -- 타팀 User FK
    title               VARCHAR(200) NOT NULL,
    description         TEXT,
    start_time          TIMESTAMP NOT NULL,
    end_time            TIMESTAMP NOT NULL,
    status              reservation_status NOT NULL DEFAULT 'CONFIRMED',
    recurrence_rule_id  BIGINT REFERENCES recurrence_rules(id),
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (end_time > start_time)
);

-- 중복 예약 방지 제약 (PostgreSQL 전용 EXCLUDE)
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE reservations
    DROP CONSTRAINT IF EXISTS no_overlap_reservation;
ALTER TABLE reservations
    ADD CONSTRAINT no_overlap_reservation
    EXCLUDE USING gist (
        space_id WITH =,
        tsrange(start_time, end_time, '[)') WITH &&
    )
    WHERE (status = 'CONFIRMED');

-- 참석자 테이블
CREATE TABLE IF NOT EXISTS attendees (
    id              BIGSERIAL PRIMARY KEY,
    reservation_id  BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    department      VARCHAR(100),
    status          attendee_status NOT NULL DEFAULT 'INVITED',
    invite_token    UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 성능 인덱스
CREATE INDEX IF NOT EXISTS idx_reservations_space_time ON reservations(space_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_reservations_user       ON reservations(user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status     ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_attendees_reservation   ON attendees(reservation_id);
CREATE INDEX IF NOT EXISTS idx_attendees_token         ON attendees(invite_token);
