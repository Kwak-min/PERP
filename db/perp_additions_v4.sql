-- =====================================================================
-- PERP 스키마 확장 v4 — [검토·승인 완료 / 실행 가능]
-- 대상: perp_db (PostgreSQL 18)
-- 전제: perp_schema.sql (+ v2/v3) 가 이미 적용돼 있어야 함
--       (org.companies 사용)
-- 목적: 회사별 "활성화된 모듈 key" 저장.
--       현재 화면 모듈 게이팅은 레거시 값(req.organization.modules,
--       콤마구분 문자열)을 보는데, perp_db 로그인 사용자는 이 값이 없어
--       선택 모듈이 전부 "꺼짐"으로 나옴. 이를 perp_db 로 옮겨,
--       로그인 시 이 테이블의 활성 모듈 key 로 게이팅한다.
-- 성격: 순수 신규 테이블 추가. 기존 테이블은 변경하지 않음(org.companies ALTER 금지).
-- 안전장치: 재실행 안전을 위해 CREATE ... IF NOT EXISTS 사용(v3 방식과 동일).
-- 설계 노트:
--   * module_key 는 TEXT. 모듈 카탈로그(key/label)는 코드
--     (backend/src/config/modules.js MODULE_CATALOG)에 있으므로
--     FK 대상 DB 테이블이 없음 → 정적 카탈로그 참조는 애플리케이션이 검증.
--   * 회사 ↔ 활성 모듈 key 의 다대다(정션). 한 회사가 같은 모듈을
--     중복 활성화하지 못하도록 (company_id, module_key) 복합 PK.
--   * 코어 모듈(members/dashboard/notifications/... core:true)은 이 테이블에
--     넣지 않는 것을 권고 — 항상 켜짐이므로 코드의 CORE_MODULES 로만 판단하고,
--     이 테이블은 OPTIONAL_MODULES 의 on/off 만 담는다. (미결정 항목 참조)
-- =====================================================================

-- =====================================================================
-- org.company_modules : 회사별 활성 모듈 (정션)
-- =====================================================================
CREATE TABLE IF NOT EXISTS org.company_modules (
    company_id  BIGINT      NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
    module_key  TEXT        NOT NULL,                 -- 모듈 카탈로그의 key (코드에서 검증)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, module_key)              -- 회사당 모듈 key 중복 방지
);

-- PK 선두 컬럼이 company_id 이므로 "회사별 활성 모듈 조회"는 PK 인덱스로 커버됨.
-- 별도 보조 인덱스는 불필요(중복 인덱스 회피). module_key 단독 역조회가
-- 필요해지면 그때 CREATE INDEX ... (module_key) 를 추가한다.

-- =====================================================================
-- 완료. 적용 후 확인용:
--   SELECT company_id, count(*) FROM org.company_modules
--     GROUP BY company_id ORDER BY company_id;
-- 롤백: DROP TABLE IF EXISTS org.company_modules;
-- =====================================================================
