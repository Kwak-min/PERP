-- enum labels must commit before v14 columns use draft/withdrawn.
BEGIN;
ALTER TYPE common.approval_status ADD VALUE IF NOT EXISTS 'draft';
ALTER TYPE common.approval_status ADD VALUE IF NOT EXISTS 'withdrawn';
COMMIT;
