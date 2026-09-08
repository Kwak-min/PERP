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
| ERP SQLite | `npm run migrate --workspace backend`; ERP 시작 전 자동 실행 | PG bearer 허용 전에 v5 `auth_identity` 적용 필수 |
| `perp_db` | `db/perp_schema.sql`, `db/perp_additions_v2.sql` 수동 관리 | 앱 시작이 적용하지 않음; PG expiry는 기존 `login_at`+TTL이라 추가 migration 없음 |
| 예약 DB | Prisma schema + local `init.sql` + `prisma/migrations/` | baseline부터 현재까지의 완전한 이력과 실제 적용 증거 필요 |

Wiki publication uses SQLite migration **14**, after Wiki storage12; **13** remains
reserved for CSV imports. For `perp_db`, apply Wiki storage
`db/perp_additions_v15_knowledge_wiki.sql`, retain CSV
`perp_additions_v16_deadline_expense_imports.sql` and analytics
`perp_additions_v17_analytics_exports.sql` in the integrated release sequence, then
apply `db/perp_additions_v18_knowledge_invalidation.sql` once. The publication
v18 schema body is unchanged from its pre-integration allocation; do not apply
it twice under both filenames. This task worktree does not ship the CSV/analytics
migrations; their owning release must supply them. ERP startup does not run PG DDL.

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
| Migration | SQLite v5/auth_identity, `perp_db` login_at+TTL canary, 예약 versioned migration | DB 변경과 배포 차단 |
| Staging | 세 서비스 real surface, 모든 DB readiness, tenant/RBAC/예약 smoke, browser E2E | production 승격 차단 |
| Production | artifact digest, backup ID, readiness, audit/finance 확인, rollback 책임자 | traffic 전환 차단 |

테스트 개수와 route 수는 고정 성공 문구로 판정하지 않습니다. 명령의 현재 exit code,
실제 pass/fail, `GET /api/v1/routes`의 현재 19개 고유 그룹을 증거로 남깁니다. 새 route가
추가되면 registry와 문서를 함께 갱신합니다.

현재 발견된 root/Reservation dependency audit 항목은 `operational-dependencies` lane에
manifest/lockfile 수정과 재검증으로 배정됐습니다. 영구 수용 또는 해결로 간주하지
않으며, 해당 lane의 `npm audit` exit 0과 회귀 test/build 영수증이 합쳐질 때까지
Security gate는 **pending/차단** 상태입니다.

## 5. 롤백

### 코드 롤백

1. 새 traffic을 차단하고 reverse proxy를 직전 ERP/예약/static artifact로 되돌립니다.
2. 구 revision이 현재 schema와 호환되는지 migration compatibility matrix로 확인합니다.
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
