-- PG native 다중 회사 소속. 애플리케이션 배포 전에 승인된 환경에 명시적으로 적용한다.
-- 이 파일은 서버 부팅 시 자동 실행하지 않는다. v1-v4가 먼저 필요하다.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_company_id ON org.departments(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_positions_company_id ON org.positions(company_id, id);

CREATE TABLE IF NOT EXISTS org.company_memberships (
    company_id BIGINT NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'left')),
    department_id BIGINT,
    position_id BIGINT,
    created_by BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, user_id),
    FOREIGN KEY (company_id, department_id) REFERENCES org.departments(company_id, id)
        ON DELETE SET NULL (department_id),
    FOREIGN KEY (company_id, position_id) REFERENCES org.positions(company_id, id)
        ON DELETE SET NULL (position_id)
);
CREATE INDEX IF NOT EXISTS idx_company_memberships_user ON org.company_memberships(user_id, status, company_id);
SELECT common.attach_updated_at('org.company_memberships');

CREATE TABLE IF NOT EXISTS org.company_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_events_company ON org.company_events(company_id, created_at);

-- primary 소속만 이관한다. 다른 회사 역할/관리자 플래그/이메일은 소속 증거가 아니다.
-- 기존 데이터가 회사 경계를 위반하면 조용히 수정하지 않고 migration 전체를 중단한다.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM auth.users u
        WHERE u.company_id IS NOT NULL AND (
            (u.department_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM org.departments d WHERE d.id = u.department_id AND d.company_id = u.company_id
            )) OR
            (u.position_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM org.positions p WHERE p.id = u.position_id AND p.company_id = u.company_id
            ))
        )
    ) THEN
        RAISE EXCEPTION 'Primary company department/position mismatch; review before membership backfill';
    END IF;
END $$;

INSERT INTO org.company_memberships (company_id, user_id, department_id, position_id, created_by)
SELECT u.company_id, u.id, u.department_id, u.position_id, u.id
FROM auth.users u JOIN org.companies c ON c.id = u.company_id
WHERE u.company_id IS NOT NULL
ON CONFLICT (company_id, user_id) DO NOTHING;

-- auth.users의 primary 회사/부서/직급은 변경하지 않는다. 기존 left/suspended 소속도 재활성화하지 않는다.
COMMIT;
