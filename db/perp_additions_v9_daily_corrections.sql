-- 일상 업무 정정: 기존 행 보존, 낙관적 잠금, 회사 단위 감사 이력.
BEGIN;
ALTER TABLE project.projects ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calendar.events ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calendar.events ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE asset.assets ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS org.daily_correction_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES org.companies(id),
  actor_id BIGINT NOT NULL REFERENCES auth.users(id),
  resource_type TEXT NOT NULL,
  resource_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  before_data JSONB NOT NULL,
  after_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_correction_company_resource
  ON org.daily_correction_events(company_id, resource_type, resource_id, id);
COMMIT;
