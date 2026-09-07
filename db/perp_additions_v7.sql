-- 사용자 정의 회사 역할. 기존 역할/권한/소속과 분리된 플랫폼 승격은 없다.
-- v5 회사 소속 스키마 이후 적용. 기존 행의 권한은 변경하지 않는다.
BEGIN;
ALTER TABLE org.roles ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'all';
ALTER TABLE org.roles ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE org.roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS org.role_change_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES org.companies(id),
  actor_id BIGINT NOT NULL REFERENCES auth.users(id),
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_role_events_company ON org.role_change_events(company_id, id);
COMMIT;
