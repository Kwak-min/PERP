-- 같은 회사 저장소에서 시작 유형만 확장한다. 기존 이름·ID·소속·권한은 수정하지 않는다.
BEGIN;
ALTER TABLE org.companies
  ADD COLUMN IF NOT EXISTS organization_type TEXT NOT NULL DEFAULT 'company';
ALTER TABLE org.companies
  DROP CONSTRAINT IF EXISTS companies_organization_type_check;
ALTER TABLE org.companies
  ADD CONSTRAINT companies_organization_type_check
  CHECK (organization_type IN ('company', 'personal', 'club', 'lab'));
COMMIT;
