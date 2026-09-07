-- =====================================================================
-- PERP schema extension v6 - independent organization feature opt-ins
-- Target: perp_db PostgreSQL, after perp_additions_v5.sql
-- Application is manual; this file is not executed by tests or startup.
-- Existing companies are intentionally not backfilled: no row means the
-- legacy contract (hr => attendance+leave, approvals => approvals).
-- Every newly created company writes one row, including an empty array.
-- =====================================================================

CREATE TABLE IF NOT EXISTS org.company_feature_settings (
    company_id       BIGINT      PRIMARY KEY REFERENCES org.companies(id) ON DELETE CASCADE,
    enabled_features TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    configured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT company_feature_settings_known_features
      CHECK (enabled_features <@ ARRAY['attendance', 'leave', 'approvals']::TEXT[])
);

-- Verification only:
-- SELECT company_id, enabled_features FROM org.company_feature_settings ORDER BY company_id;
-- Rollback: DROP TABLE IF EXISTS org.company_feature_settings;
