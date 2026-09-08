-- Task24: 파일/캐시가 아닌 인가된 재조회 요청. 기존 장부/결재 스키마는 수정하지 않는다.
CREATE TABLE IF NOT EXISTS org.analytics_export_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
  requested_by BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL CHECK (report_key IN ('members','tasks','transactions','budgets','approvals_created','approvals_decided')),
  filter JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS analytics_export_jobs_owner ON org.analytics_export_jobs(company_id,requested_by,id);
