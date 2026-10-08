-- 역할 교체 CAS만 추가한다. 기존 역할/기능/소속을 변경하거나 관리자를 복구하지 않는다.
BEGIN;
ALTER TABLE org.company_memberships ADD COLUMN IF NOT EXISTS roles_version INTEGER NOT NULL DEFAULT 1;
COMMIT;
