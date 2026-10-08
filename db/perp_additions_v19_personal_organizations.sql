-- 개인 조직 유형을 회사 저장소에 보존한다. 기존 회사와 소속은 변경하지 않는다.
ALTER TABLE org.companies
  ADD COLUMN IF NOT EXISTS organization_type TEXT NOT NULL DEFAULT 'company'
  CHECK (organization_type IN ('company', 'personal'));
