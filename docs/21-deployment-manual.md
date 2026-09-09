# 배포 매뉴얼 (Deployment Manual)

## 1. 환경 분리

### 서비스와 데이터베이스

| 환경 | ERP SQLite | ERP 인증 PostgreSQL | 예약 PostgreSQL | Frontend/AI |
|---|---|---|---|---|
| local | 환경별 임시/개발 파일 | 선택적 SSH 터널의 원격 `perp_db`; 없으면 PG 기능 503 | 별도 `room_reservation` 개발 DB | Vite + echo 기본 |
| staging | staging 전용 영속 volume | staging 전용 DB/schema와 계정 | staging 전용 DB와 계정 | immutable preview + 정책 provider |
| production | 암호화된 production volume | PostgreSQL 18 `perp_db` | 별도 예약 DB | static `dist` + 승인 provider |

환경 간 DB, SQLite 파일, 업로드, secret, SMTP 계정, OpenRouter quota와 webhook
secret을 공유하지 않습니다. ERP는 SQLite와 `perp_db`를 동시에 사용하며 예약 DB는
세 번째 별도 저장 경계입니다.

`infra/docker-compose.yml`은 PG 16 `orbitflow`, Redis, MinIO만 제공하는 로컬 보조
인프라입니다. ERP/SPA/예약 서비스가 정의돼 있지 않고 원격 `perp_db`의 이름,
버전, 사용자, 포트와 일치하지 않습니다. `Reservation/backend/docker-compose.yml`도
예약 DB의 로컬 초기화용이며 배포 명세가 아닙니다. 두 compose는 기본 host port
5432가 충돌합니다.

### Migration 소유권

| 저장소 | 현재 적용 경로 | 배포 주의 |
|---|---|---|
| ERP SQLite | `npm run migrate --workspace backend`; ERP 시작 전 자동 실행 | PG bearer 허용 전에 v5 `auth_identity` 적용 필수. 이번 기능군은 9(역할) → 10(원증빙·실지출) → 11(결재) → 12(Wiki) → 13(CSV 가져오기) → 14(Wiki 무효화). 번호 Set 적용이므로 비연속 허용 |
| `perp_db` | `db/perp_schema.sql`, `db/perp_additions_v2.sql`~`v10` 기존 + 아래 v11~v18 수동 관리 | 앱 시작이 적용하지 않음; PG expiry는 기존 `login_at`+TTL이라 추가 migration 없음 |
| 예약 DB | Prisma schema + local `init.sql` + `prisma/migrations/` | baseline부터 현재까지의 완전한 이력과 실제 적용 증거 필요 |

`perp_db` 신규 additive DDL은 다음 순서로 한 번씩 적용합니다. 실제 적용 결과(파일, 시각,
적용 계정, backup ID)를 기록하며, 이 저장소의 검증은 격리된 PostgreSQL 18에서만 수행됐고
운영 DB에는 적용하지 않았습니다.

| 순서 | 파일 | 주의 |
|---|---|---|
| v11 | `db/perp_additions_v11_deadline_roles.sql` | `roles_version` 추가만; 역할/관리자 데이터 변경 없음 |
| v12 | `db/perp_additions_v12_deadline_expenses.sql` 다음 `db/perp_additions_v12_deadline_expense_writer.sql` | 두 파일 순서 고정; 금액은 기존 전표/lines만 소유 |
| v13 | `db/perp_additions_v13_approval_states.sql` | `ALTER TYPE ... ADD VALUE`는 **독립 commit**이어야 하며 v14와 같은 transaction에 넣지 않음 |
| v14 | `db/perp_additions_v14_approval_details.sql` | v13 commit 뒤에만 적용 |
| v15 | `db/perp_additions_v15_knowledge_wiki.sql` | `knowledge` schema 생성; v18보다 먼저 |
| v16 | `db/perp_additions_v16_deadline_expense_imports.sql` | CSV 가져오기; v15와 번호 분리 |
| v17 | `db/perp_additions_v17_analytics_exports.sql` | export 요청 metadata만; 데이터/파일 복제 없음 |
| v18 | `db/perp_additions_v18_knowledge_invalidation.sql` | v15 뒤 한 번; `pg_notify('orbitflow_wiki_invalidated')` trigger |

enum 값(v13)은 PostgreSQL에서 제거할 수 없으므로 rollback matrix에 "additive, 되돌리지
않음"으로 기록합니다. Wiki v15/v18의 SQLite 대응은 12/14이며, 두 저장소를 한쪽만 적용한
상태로 traffic을 열면 해당 저장소의 Wiki 요청만 503이 됩니다.

예약의 `npm run db:migrate`는 `prisma migrate dev`, `db:push`는 migration 이력을
만들지 않는 개발 명령입니다. 둘 다 production migration 대체로 사용하지 않습니다.
현재 worktree의 정확한 incremental SQL은
`Reservation/backend/prisma/migrations/20260907010000_add_organization_scope/migration.sql`입니다.
Nullable tenant/org/owner column과 organization-aware
`no_overlap_reservation_org` GiST exclusion constraint를 추가합니다. NULL scope인
legacy row는 의도적으로 격리되며 검증된 ownership mapping 없이는 backfill하지
않습니다. 최초 schema의 versioned baseline과 실제 PostgreSQL 적용/복구/동시
transaction 증거는 확인되지 않았습니다. `init.sql`은 legacy snake_case bootstrap인
반면 현재 Prisma model/migration은 quoted camelCase이므로 직접 적용 전에 Prisma
baseline으로 reconcile해야 합니다. `init.sql`도 새 local compose volume 최초 생성
때만 실행됩니다. Production에는 완전한 baseline과 검토된 migration 이력,
`prisma migrate deploy` 적용 절차가 먼저 필요합니다.

## 2. 사전 준비

1. 전체 workspace용 Node.js 22.12+와 잠금 파일에 맞는 npm을 설치합니다.
2. ERP, frontend, 예약 API를 독립 revision/artifact로 식별합니다. 루트 `npm ci`는
   `Reservation/backend`를 설치하지 않으므로 예약 디렉터리에서 별도 실행합니다.
3. Secret Manager에 `PG_PASSWORD`/`DATABASE_URL`, OpenRouter key, webhook secret,
   예약 DB URL, SMTP credential을 환경별로 준비합니다. secret을 image, 로그,
   source, frontend `VITE_*`에 넣지 않습니다.
4. SQLite 영속 volume, `perp_db`, 예약 DB, 실제 upload/object 저장소와 암호화 backup
   목적지를 각각 준비합니다. backup ID에 app revision과 세 DB version을 연결합니다.
5. ERP는 `127.0.0.1`에 bind하므로 같은 호스트의 TLS reverse proxy 또는 명시적인
   네트워크 구성이 필요합니다. SPA에서 ERP/예약 API의 CORS와 URL을 확인합니다.
6. staging/production의 안전한 테스트 principal과 tenant/org, smoke 대상 데이터를
   준비합니다. Health endpoint만으로 traffic을 전환하지 않습니다.
7. `ORBITFLOW_UPLOAD_DIR`를 영속·백업 대상 volume으로 지정합니다. 원증빙 원본은 이
   경로에 저장되며 DB link와 같은 backup ID로 묶어야 합니다.
8. LLM Wiki를 켤 환경에는 `WIKI_LOCAL_MODEL_CONFIG`(numeric loopback origin, 실제 loaded
   model ID, context/output token, timeout)를 준비합니다. 값이 없으면 Wiki job은
   `unavailable`로 끝나고 나머지 Wiki 읽기/원본 등록은 동작합니다. 범용
   `ORBITFLOW_AI_PROVIDER`/OpenRouter/Echo 설정은 Wiki에 적용되지 않습니다.
9. CSV 가져오기 원본(24시간)과 원증빙 staging(24시간) 정리는 ERP 내장 timer를 **각각 env로
   활성화**합니다. `ORBITFLOW_IMPORT_CLEANUP_STORES`(CSV)와 `ORBITFLOW_RECEIPT_CLEANUP_STORES`
   (원증빙)는 서로 독립이며 둘 다 기본 비활성입니다. cadence `ORBITFLOW_IMPORT_CLEANUP_INTERVAL_MS`
   (기본 1시간)와 `ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS`(기본 30초)는 두 종류가 공유합니다. 원증빙을
   켤 때는 API와 같은 절대 경로의 기존 `ORBITFLOW_UPLOAD_DIR`가 필수입니다. multi-process에서는 한
   프로세스만 켭니다. stdout `expense_import_cleanup` 이벤트(종류·store별 건수, `shared>0` 검토)를
   수집·알림하는 collector와 보존은 배포 대상이 준비합니다. `backend/.env.example`에는 두 opt-in의
   빈 기본값과 주석 예시가 있으며 백엔드 단위가 관리합니다. 실제 `.env` 값은 Secret Manager에서
   주입합니다. 상세는 `docs/20-operations-manual.md`의 정기 정리 절을 따릅니다.

### Remote 배포 차단 조건

다음 항목 중 하나라도 없으면 production 배포를 중단합니다.

- 승인된 배포 대상 host/정적 호스팅/reverse proxy/TLS 구성과 접근 권한
- `perp_db` SSH/네트워크 경로, 최소권한 credential, 실제 schema 및 `login_at`/TTL 증거
- ERP SQLite migration v5 `auth_identity` 적용 및 PG bearer canary 증거
- 기존 숫자 ID membership의 소유권 검증과 명시적 repair 목록(자동 adoption 금지)
- 별도 예약 PostgreSQL endpoint/credential, 완전한 Prisma baseline과 정확한
  `20260907010000_add_organization_scope` 적용 증거
- Tenantless legacy row의 검토된 ownership mapping/backfill 계획과, organization-aware
  exclusion constraint의 실제 동시 transaction 검증
- Secret Manager 주입과 회전 절차; production webhook/AI/SMTP 값
- SQLite/두 PostgreSQL/실제 업로드를 모두 포함하는 암호화 backup과 복구 권한
- 최근 격리 restore rehearsal 및 RPO 24시간/RTO 4시간 **목표** 측정 결과
- 최종 인증/예약 lane 계약에 맞춘 principal, CORS, smoke test 승인
- `perp_db` v11~v18과 SQLite 9~14의 실제 적용 순서·결과 기록(v13 독립 commit 포함)
- `ORBITFLOW_UPLOAD_DIR` 영속 volume과 backup 포함 증거
- 정리 timer의 활성화 증거(기동 이벤트의 `stores`와 `receipt_stores` 선택값), 종류·store별
  `succeeded` 이벤트를 수집하는 collector·알림 전송 증거, 원증빙 upload root의 영속 volume 증거
  (소스 배선 존재만으로는 미충족; 활성화 전 코드·설정·종료 검증이 필요)
- Wiki를 켤 경우 `WIKI_LOCAL_MODEL_CONFIG`와 로컬 모델 서버의 loaded 상태 확인; 끌 경우
  사용자에게 `unavailable`이 정상 상태라는 공지

저장소 검증이나 local compose 성공은 이 조건을 대체하지 않습니다.

## 3. 배포 절차

### 빌드와 정적 게이트

```bash
# repository root: ERP + frontend + 문서/구조
npm ci
npm test
npm run build
node scripts/check_local_startup.mjs
node scripts/check_structure.mjs
python scripts/check_docs_coverage.py
python scripts/check_deliverables.py
npm audit

# separate reservation package
cd Reservation/backend
npm ci
npm run db:generate
npm test
npm run build
npm audit
```

`check_docs_coverage.py`는 실제 DOCX/XLSX에서 추출한
`.omo/src-과업지시서.txt`와 `.omo/src-요구사항정의서.txt`가 있을 때만 실행합니다.
원본이나 추출물이 없으면 실패를 보고하고 문서 coverage를 통과로 대체하지 않습니다.

격리 실행이 필요한 검증(node/npm/python)은 `node scripts/run_deadline_isolated.mjs <명령>
<인자>`로 감쌉니다. runner는 `DATABASE_URL`/`PG_*`/provider key/`NODE_OPTIONS`를 비우고
fixture가 정한 임시값만 넘기므로 실제 사용자 서비스(8000/5174/8080/55432)나 private
`.env`에 닿지 않습니다.

### 고정 의존성 버전과 라이선스 고지

아래 exact pin은 보안 advisory 대응으로 확정된 값이며 lockfile과 함께 배포합니다. `npm audit
fix --force`나 범위 지정으로 바꾸지 않습니다. 새 advisory가 나오면 해당 패키지만 최소 수정판으로
다시 고정하고 fresh audit를 다시 받습니다.

| 패키지 | 버전 | 위치 | 라이선스 / 고지 |
|---|---|---|---|
| `csv-parse` | 7.0.2 | `backend/package.json` | MIT. GHSA-8cw4-87c7-c6xx(<7.0.2) 대응. parser provenance `expense-csv-v1:csv-parse@7.0.2` |
| `file-type` | 21.3.2 | backend | MIT. GHSA-5v7r-6r5c-r473, GHSA-j47w-4g3g-c36v 대응 |
| `pdf-lib` | 1.17.1 | backend | MIT |
| `sharp` | 0.35.4 | backend | Apache-2.0. GHSA-f88m-g3jw-g9cj(<0.35.0), GHSA-rgj7-g3m4-5g8c(<0.35.4) 대응 |
| `@img/sharp-win32-x64` | 0.35.4 | backend (Windows native) | **Apache-2.0 AND LGPL-3.0-or-later**. libvips 등 번들 라이브러리 고지는 `node_modules/@img/sharp-win32-x64/README.md`, `LICENSE`, `versions.json`을 그대로 보존 |
| `3d-force-graph` | 1.80.0 | `frontend/package.json` | MIT. `frontend/THIRD_PARTY_NOTICES.md` |
| `three` | 0.185.1 | frontend (lock) | MIT. `frontend/THIRD_PARTY_NOTICES.md`; 임의 latest 전역 업데이트 금지 |
| `js-yaml` | 4.3.2 | `Reservation/backend/package-lock.json` | MIT. GHSA-2883-xcg3-v3hh(4.3.1) 대응 |

sharp의 Windows native binary는 JS 패키지의 Apache-2.0만으로 표시할 수 없습니다. 번들된
libvips/glib/libheif/librsvg 등 LGPLv3 구성요소 때문에 재배포 시 해당 소스 제공·교체 가능성
의무와 설치본의 license/README/NOTICE 원문을 보존해야 합니다. 세부 목록은
`backend/src/services/receipt-files.contract.md`의 라이선스 표를 따릅니다. 이 표는 법적 충족
인증이 아니라 보존해야 할 원문의 위치 기록입니다. 배포 artifact에는
`frontend/THIRD_PARTY_NOTICES.md`, `db/perp_additions_v15_knowledge_wiki.sql`,
`db/perp_additions_v18_knowledge_invalidation.sql`이 모두 포함되어야 하며, 빠진 상태의 artifact는
License/Migration gate를 통과하지 못합니다.

### Staging 배포

1. 쓰기 차단 계획과 rollback 책임자를 확인하고 SQLite, `perp_db`, 예약 DB, 실제
   업로드를 같은 backup ID로 백업합니다.
2. DBA가 `perp_db`와 예약 DB의 현재 schema/version을 확인합니다. PG expiry는 기존
   `auth.sessions.login_at`과 배포 TTL을 쓰므로 PG DDL 없이 column/value canary를
   수행합니다. 검토된 additive migration만 각 저장소에 별도로 적용합니다.
3. 새 ERP revision을 기존 traffic과 분리된 listener에서 시작합니다. SQLite
   migration v5와 `auth_identity` table/index를 확인한 뒤에만 PG bearer를 보냅니다.
   Migration 실패 시 listener가 열리지 않아야 합니다.
4. 예약 DB를 backup한 뒤 정확한 `20260907010000_add_organization_scope` migration을
   `prisma migrate deploy`로 적용합니다. Constraint 존재와 tenant/org/space 범위를
   확인하고, tenantless legacy row는 승인된 mapping 전까지 NULL/비가시 상태로 둡니다.
5. 예약 API를 별도 revision으로 시작합니다. Startup의 Prisma connect 성공과
   versioned migration 적용 결과를 확인합니다.
6. `frontend/dist`를 immutable static release로 배포하고 ERP 및 예약 API URL을
   해당 환경에 고정합니다.
7. 세 서비스 liveness 후 `perp_db` health/TTL, PG bearer의 `auth_identity` mapping,
   인증된 SQLite 업무 읽기, 인증된 예약 DB 읽기, tenant/org/RBAC, audit/finance 합계,
   SPA asset을 확인합니다. 기존 숫자 ID membership은 자동 연결하지 않습니다.
8. 서로 다른 tenant/org에서 같은 room/time을 허용하고 같은 tenant/org의 동시
   transaction은 DB constraint로 하나만 성공하는지 실제 PostgreSQL에서 검증합니다.
   Application pre-check test만으로 concurrency proof를 대체하지 않습니다.
9. PG signup + SQLite 초대 수락은 cross-store atomic transaction이 아닙니다. 의도적
   실패 probe에서 PG account만 남아도 membership 없이 접근이 거절되는지 확인하고,
   retry/incident 절차를 검증합니다.
10. 실제 브라우저 E2E와 오류/overflow/teardown 증거를 보존합니다. Staging에서만
   통과한 뒤 production 승인으로 이동합니다.
11. 기능별 smoke를 추가로 수행합니다. 역할 저장의 stale 409와 마지막 관리자 보호,
    원증빙 업로드→소비→`attachment` 다운로드 checksum 일치, CSV upload→preview→`{}`
    commit→같은 key replay, 분석 KPI의 `unavailable` reason이 예상 범위인지, Wiki
    root 200과(모델을 켠 경우) query job의 `succeeded` 또는 `no_evidence`. 모델을 끈
    환경은 `unavailable`이 정상이며 실패로 기록하지 않습니다.
12. staging에서 CSV와 원증빙 정리를 모두 켠 상태로 한 interval 이상 운영하고 기동 이벤트의
    `stores`/`receipt_stores`, 종류(`imports`/`receipts`)·store별 `succeeded` 이벤트와 건수,
    `shared>0`·`unlink_failed` 유무, collector 수집 결과를 기록합니다. 정리 없이 24시간이 지나면
    CSV job이 410으로 바뀌는 것은 정상 만료(DB 시각 기준)이며 정리 미실행과 구분해 기록합니다.

### Production 배포

1. Staging과 동일 artifact digest, migration 목록, backup ID와 승인자를 확인합니다.
2. 각 DB migration을 정해진 순서로 적용하고 실제 version을 기록합니다. ERP 시작이
   `perp_db` 또는 예약 migration까지 처리한다고 가정하지 않습니다.
3. 새 ERP/예약 revision과 static release를 비공개 target에서 기동합니다.
4. `/health`만이 아니라 모든 datastore readiness와 승인된 업무 smoke를 통과시킵니다.
5. Reverse proxy traffic을 점진 전환하고 5xx, DB error, auth failure, 예약 충돌,
   audit/finance 지표를 관찰합니다.
6. 안정화 기준을 충족하면 구 revision을 정상 종료하고 listener, scheduler, 임시
   파일을 정리합니다. 실패하면 즉시 traffic 전환을 중단하고 롤백합니다.

## 4. 배포 게이트

| 단계 | 필수 게이트 | 실패 시 |
|---|---|---|
| Source | lockfile 설치, root tests/build, 예약 tests/build | merge/승격 차단 |
| Contract | structure, deliverables, 실제 source extract 기반 docs coverage | 누락을 기록하고 승격 차단 |
| Security | root/예약 audit, secret scan, CORS/TLS/Secret Manager 검토 | 통과 영수증까지 배포 차단 |
| Migration | SQLite v5/auth_identity와 9~14, `perp_db` login_at+TTL canary와 v11~v18 순서(v13 독립 commit), 예약 versioned migration | DB 변경과 배포 차단 |
| Runtime wiring | `ORBITFLOW_UPLOAD_DIR` 절대 경로 기존 디렉터리·영속 volume(API와 정리 worker가 같은 root 공유), `ORBITFLOW_IMPORT_CLEANUP_STORES`/`ORBITFLOW_RECEIPT_CLEANUP_STORES` 활성화 + stdout 이벤트 collector, (Wiki 사용 시) `WIKI_LOCAL_MODEL_CONFIG` | 해당 기능 traffic 차단 |
| License | 위 exact pin과 lockfile 일치, `@img/sharp-win32-x64` LGPL 고지와 `frontend/THIRD_PARTY_NOTICES.md` 포함 | 배포 artifact 승격 차단 |
| Staging | 세 서비스 real surface, 모든 DB readiness, tenant/RBAC/예약 smoke, browser E2E | production 승격 차단 |
| Production | artifact digest, backup ID, readiness, audit/finance 확인, rollback 책임자 | traffic 전환 차단 |

테스트 개수와 route 수는 고정 성공 문구로 판정하지 않습니다. 명령의 현재 exit code,
실제 pass/fail, `GET /api/v1/routes`의 현재 21개 고유 그룹을 증거로 남깁니다. 새 route가
추가되면 registry와 문서를 함께 갱신합니다.

이전에 발견된 root/Reservation dependency audit 항목은 `csv-parse@7.0.2`, `sharp@0.35.4`,
`js-yaml@4.3.2` exact pin으로 대응했고, 각 계약 문서가 당시 fresh `npm audit` 0건을
기록합니다. 그 기록은 그 시점의 증거이며, Security gate는 매 배포마다 현재 lockfile로
`npm audit`를 다시 실행한 exit code로 판정합니다. 과거 영수증을 재사용하지 않습니다.

## 5. 롤백

### 코드 롤백

1. 새 traffic을 차단하고 reverse proxy를 직전 ERP/예약/static artifact로 되돌립니다.
2. 구 revision이 현재 schema와 호환되는지 migration compatibility matrix로 확인합니다.
   v11~v18과 SQLite 9~14는 모두 additive이므로 구 코드가 새 column을 무시하는 한 DB를
   되돌리지 않습니다. v13 enum 값은 제거할 수 없습니다. 새 코드로 게시된 Wiki page
   revision, 소비된 원증빙 link, 완료된 CSV job은 rollback 뒤에도 남으며 삭제하지 않습니다.
3. 세 liveness와 모든 DB readiness, 로그인, tenant/org/RBAC, 예약 scope,
   audit/finance를 재검증합니다.
4. 원인, request ID, artifact digest, migration/version, backup ID, 영향 조직과 시간을
   incident에 기록합니다.

### 데이터 복구가 필요한 롤백

데이터 restore는 코드 rollback과 다르며 배포 후 정상 write를 잃을 수 있습니다.
호환 가능한 additive migration은 원칙적으로 DB를 되돌리지 않습니다. 불가피한 경우:

1. 쓰기를 차단하고 incident 시점의 원본 SQLite/두 PostgreSQL/업로드를 보존합니다.
2. 승인자가 예상 데이터 손실 구간과 RPO/RTO 영향을 확인합니다.
3. 운영에 직접 덮어쓰기 전에 격리 환경에서 backup checksum과 restore를 검증합니다.
4. SQLite, `perp_db`, 예약 DB, 업로드를 동일한 backup ID 기준으로 복구합니다.
5. 전체 readiness와 도메인 합계를 확인한 뒤 승인된 시점에만 traffic을 재개합니다.

운영 DB를 수동 편집하거나 실패 test를 삭제/skip해서 롤백을 우회하지 않습니다.
**RPO 24시간/RTO 4시간은 목표일 뿐, 실제 원격 restore rehearsal 기록 없이는 달성으로
보고할 수 없습니다.**
