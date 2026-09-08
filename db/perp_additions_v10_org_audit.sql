-- F8 조직 자리/배정 원자 갱신 및 회사 범위 감사 기록. v5 이후 명시적으로 적용한다.
-- 서버 부팅 시 자동 실행하지 않으며 기존 회사 역할/권한은 변경하지 않는다.
BEGIN;
ALTER TABLE org.companies ADD COLUMN IF NOT EXISTS org_revision BIGINT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS org.organization_change_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES org.companies(id),
  actor_id BIGINT NOT NULL REFERENCES auth.users(id),
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('department.created', 'department.updated', 'member.assignment.updated')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('department', 'member')),
  resource_id TEXT NOT NULL,
  target TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB NOT NULL,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_change_company_id ON org.organization_change_events(company_id, id DESC);

-- 다른 등록 경로의 구성원/부서 변경도 열린 자리 편집의 기준을 무효화한다.
CREATE OR REPLACE FUNCTION org.bump_organization_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE org.companies SET org_revision = org_revision + 1 WHERE id = COALESCE(NEW.company_id, OLD.company_id);
  RETURN NULL;
END;
$$;
CREATE OR REPLACE TRIGGER trg_organization_revision AFTER INSERT OR UPDATE OR DELETE ON org.departments
  FOR EACH ROW EXECUTE FUNCTION org.bump_organization_revision();
CREATE OR REPLACE TRIGGER trg_organization_revision AFTER INSERT OR UPDATE OR DELETE ON org.company_memberships
  FOR EACH ROW EXECUTE FUNCTION org.bump_organization_revision();
COMMIT;
