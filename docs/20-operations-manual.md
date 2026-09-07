# 운영 매뉴얼 (Operations Manual)

## 1. 시스템 구성

### 런타임 토폴로지

| 구성요소 | 역할 | 기본 주소/포트 | 영속 저장소 |
|---|---|---|---|
| `orbitflow-frontend` | Vite/React SPA; ERP와 예약 API 호출 | `127.0.0.1:5173` (dev) | 없음; 운영은 정적 `dist` |
| `orbitflow-backend` | Express ERP API, AI Gateway, audit chain | `127.0.0.1:8000` | SQLite + 원격 `perp_db` |
| `room-reservation` | 별도 Express/Prisma 예약 API | `localhost:8080` | 별도 `room_reservation` PostgreSQL |
| Ollama (선택) | 민감 데이터용 로컬 AI provider | `localhost:11434` | 모델 저장소(운영자가 별도 관리) |

루트 npm workspace는 ERP API와 SPA만 설치합니다. `Reservation/backend`는 별도
패키지, 별도 프로세스, 별도 migration 생명주기를 가집니다. SPA는
`VITE_API_BASE_URL`과 `VITE_RESERVATION_API_URL`로 두 API에 연결됩니다.

ERP API 내부도 DB가 하나가 아닙니다. `ORBITFLOW_DATABASE_FILE`의 SQLite가
기존 업무 데이터를 보유하고, `DATABASE_URL` 또는 `PG_*`로 연결하는 PostgreSQL
18 `perp_db`가 인증 슬라이스를 보유하는 병행 이관(strangler-fig) 구조입니다.
SQLite만 백업하거나 점검해서 전체 시스템이 준비됐다고 판정하면 안 됩니다.

`infra/docker-compose.yml`은 PG 16(`orbitflow` DB/사용자), Redis, MinIO를 띄우는
로컬 개발 보조 파일입니다. 서비스 컨테이너가 없고 ERP 기본 `perp_db`
설정과도 일치하지 않으므로 배포 명세가 아닙니다. 예약 compose는 별도의 PG 16
`room_reservation`을 같은 호스트 포트 5432에 노출하므로 두 compose를 기본값으로
동시에 실행할 수도 없습니다. 포트와 env를 명시적으로 분리하십시오.

외부 AI는 정책상 허용할 때만 OpenRouter를 활성화합니다. 실제 secret은
`backend/.env`, `Reservation/backend/.env` 같은 커밋 제외 파일 또는 운영 Secret
Manager에서 주입하고 로그, image, `VITE_*` 값에 넣지 않습니다.

## 2. 기동과 상태 점검

### 기동 전 점검

1. 전체 workspace에는 Node.js 22.12+와 npm을 준비합니다. 예약 API도 별도로
   `npm ci`가 필요합니다.
2. 예제 env에서 각 서비스의 런타임 env를 만들되 실제 secret은 별도 채널에서
   주입합니다. ERP 운영에서는 빈 `PG_PASSWORD`, 기본 webhook secret, 개발 AI
   provider 값을 허용하지 않습니다.
3. SQLite 경로가 영속 디스크에 있고 ERP 실행 계정이 디렉터리를 읽고 쓸 수 있는지
   확인합니다.
4. 원격 `perp_db`에는 승인된 SSH 터널/네트워크 경로와 최소권한 DB 계정이 필요합니다.
   저장소의 `infra/docker-compose.yml`로 대체하지 않습니다.
5. 예약 API에는 `DATABASE_URL`이 가리키는 별도 DB와 적용 완료된 예약 schema가
   필요합니다. 정확한 migration은
   `Reservation/backend/prisma/migrations/20260907010000_add_organization_scope/migration.sql`입니다.
   SMTP는 메일 기능을 켤 때 별도 확인합니다.

### 로컬 기동

```bash
# root workspace
npm ci
npm run dev:backend             # terminal 1: ERP :8000
npm run dev                     # terminal 2: SPA :5173

# 별도 예약 서비스
cd Reservation/backend
npm ci
npm run db:generate
npm run dev                     # terminal 3: 예약 :8080, DB가 먼저 준비돼야 함
```

ERP `server.js`는 SQLite migration 성공 후에만 listener를 엽니다. PG bearer를
받기 전 schema migration version 5와 `auth_identity(provider, subject, user_id)` 및
index 적용을 확인하십시오. 이 mapping은 PG subject를 독립 운영 사용자에 연결하며,
기존 숫자 ID membership을 이메일/ID 추측으로 자동 채택하지 않습니다. Legacy 행은
운영자가 별도 소유권 증거를 확인한 뒤 mapping과 membership을 수리해야 합니다.

원격 `perp_db`에는 기동 시 전체 migration을 적용하지 않습니다. PG session 만료는
기존 `auth.sessions.login_at` + `ORBITFLOW_SESSION_TTL`로 판정하므로 이 변경을 위한
PG migration은 없지만, 실제 column/value와 TTL 동작은 원격 readiness에서 확인해야
합니다. PostgreSQL 기능은 실제 요청 시 연결 실패할 수 있습니다. 예약 `server.ts`는
시작 시 Prisma `$connect()`가 실패하면 listener를 열지 않습니다. 예약 scope migration은
`Space`/`RecurrenceRule`/`Reservation`/`Waitlist`에 nullable tenant/org/owner 경계를
추가합니다. NULL인 legacy row는 소유권을 추측하지 않고 조회에서 격리하며, 검증된
운영 mapping 전에는 값을 채우지 않습니다. `tenantId + orgId + spaceId + tsrange`의
GiST exclusion constraint가 동시 중복 예약의 최종 권위지만 실제 PostgreSQL 적용과
동시 transaction은 이 환경에서 검증되지 않았습니다.

운영은 `npm run build` 결과인 `frontend/dist`를 immutable 정적 release로 배포하고,
ERP는 루트 `npm start`, 예약은 예약 디렉터리의 `npm run build && npm start`로
기동합니다. Reverse proxy는 `/api/v1`의 소유 서비스를 혼동하지 않도록 ERP와
예약 경로/호스트를 명시적으로 분리해야 합니다.

### Liveness와 readiness

| 점검 | 의미 | 정상 기준 | 한계 |
|---|---|---|---|
| ERP `GET /health` | liveness | HTTP 200, `status=ok`, `service=orbitflow-backend` | DB를 질의하지 않음 |
| ERP `GET /api/v1/routes` | route wiring | HTTP 200, `prefix=/api/v1`, 현재 19개 고유 그룹 | 데이터 저장소 readiness 아님 |
| ERP `GET /api/v1/pg/health` | `perp_db` 연결/schema canary | HTTP 200, `status=ok`, `database=perp_db` | SQLite/예약 DB를 확인하지 않음 |
| ERP 인증된 업무 smoke | SQLite 업무 readiness | 승인된 테스트 계정으로 읽기 1건과 tenant/org 범위 확인 | 계정과 안전한 대상 endpoint 필요 |
| 예약 `GET /health` | 예약 프로세스 liveness | HTTP 200, `status=ok` | 호출 시 DB를 다시 질의하지 않음 |
| 예약 인증된 읽기 smoke | 예약 DB readiness | 승인된 principal로 공간 목록 등 읽기 성공 | 인증 계약과 별도 DB 필요 |
| SPA `GET /` 및 asset | 정적 release liveness | HTML과 fingerprint asset HTTP 200 | 두 API의 readiness 아님 |

Traffic 전환은 표의 liveness만으로 하지 않습니다. SQLite v5 migration과
`auth_identity` canary, `perp_db` health/TTL, SQLite 업무 smoke, 예약 DB smoke,
SPA asset을 모두 통과해야 전체 readiness입니다. 현재 코드에는 모든 저장소를 합친
단일 readiness endpoint가 없습니다.

Audit chain은 인증 후 `GET /api/v1/integrations/audit/verify`의 `valid=true`를
확인합니다. AI 운영 시 `GET /api/v1/agent/providers`와
`GET /api/v1/agent/usage`도 인증된 principal로 확인합니다.

안전한 로컬 ERP 기동 검증은 다음 명령으로 수행합니다.

```bash
node scripts/check_local_startup.mjs
```

이 명령은 임시 SQLite와 임의 포트를 사용하고 listener, DB, 임시 디렉터리를
정리합니다. 원격 PostgreSQL이나 예약 DB에는 접속하지 않습니다.

## 3. 백업·복구

### 백업 범위

| 저장 대상 | 반드시 보존할 내용 | 방법/주의 |
|---|---|---|
| ERP SQLite | `ORBITFLOW_DATABASE_FILE`의 DB와 백업 시점에 남은 WAL | 쓰기 차단 후 ERP 정상 종료, 하나의 일관된 세트로 복사 |
| `perp_db` PostgreSQL | 모든 app schema/data 및 복구에 필요한 role/grant 정의 | 관리형 snapshot 또는 검증된 `pg_dump`/provider backup |
| 예약 PostgreSQL | `room_reservation` schema/data | 예약 DB 전용 snapshot 또는 `pg_dump` |
| 파일/객체 | 환경별 실제 업로드 경로; 향후 연결 시 MinIO/object bucket | DB 레코드와 같은 복구 시점/manifest로 보존 |
| 설정과 secret | 배포 설정의 secret 없는 사본, Secret Manager 버전/복구 정책 | DB dump에 secret을 넣지 않고 별도 접근통제 |
| 정적 release | 배포한 frontend `dist`와 backend revision 식별자 | DB backup과 code revision을 함께 기록 |

현재 `backend/src/uploads`는 구조 계약상 존재하지만 코드에서 영속 업로드 저장소로
연결되지는 않았습니다. 실제 파일 저장을 도입하면 경로 또는 object bucket을 backup
inventory에 추가해야 합니다. `infra`의 MinIO volume도 현재 애플리케이션 연결 근거가
없으므로 운영 저장소라고 가정하지 않습니다.

### 백업 절차

1. backup ID, UTC 시각, app revision, 각 DB/schema version을 기록합니다.
2. 쓰기 유입을 차단하고 ERP 및 예약 worker/API를 정상 종료합니다.
3. SQLite process가 닫힌 뒤 DB와 남은 `-wal` 파일을 같은 backup set으로 복사하고
   checksum을 기록합니다. 실행 중인 DB 파일들을 시간차로 단순 복사하지 않습니다.
4. `perp_db`와 예약 DB를 각각 별도 snapshot/dump로 보존하고 server-side checksum,
   암호화, 보존 잠금, 만료 정책을 확인합니다. 두 DB를 한 DB로 간주하지 않습니다.
5. 실제 업로드/object와 release manifest를 같은 backup ID에 연결합니다.
6. backup reader 권한으로 목록, 크기, checksum, 최근 성공 시각을 확인하고 실패 시
   알림을 발생시킵니다.

예시 문법(placeholder는 운영 값으로 대체, 이 저장소에서 원격 실행하지 않음):

```bash
pg_dump --format=custom --file=perp_db.dump "$PERP_DATABASE_URL"
pg_dump --format=custom --file=room_reservation.dump "$RESERVATION_DATABASE_URL"
sha256sum orbitflow.db perp_db.dump room_reservation.dump
```

### 복구 리허설

1. 운영과 격리된 복구 네트워크/계정/스토리지를 준비하고 복구 시작 시각을 기록합니다.
2. 기대 backup ID와 checksum을 검증한 뒤 SQLite, `perp_db`, 예약 DB, 실제 업로드를
   각각 복구합니다. 운영 endpoint나 운영 volume 위에 덮어쓰지 않습니다.
3. backup에 기록된 code revision을 배치하고 additive migration은 사전 검토 후 각
   저장소별로 적용합니다. 예약 DB와 `perp_db` migration을 ERP SQLite migration으로
   대체하지 않습니다.
4. 세 서비스 liveness와 모든 readiness canary, tenant/RBAC, 예약 조직 범위,
   audit chain, finance 원장/보고서 합계를 검증합니다.
5. 복구 완료 시각, 실제 데이터 손실 구간, 걸린 시간, 불일치와 후속 조치를 기록한
   뒤 격리 환경을 폐기합니다.

**RPO 24시간과 RTO 4시간은 목표이며 달성 실적이 아닙니다.** 운영 backup 주기와
리허설 결과로 각각 실제 복구 지점 간격과 복구 소요 시간을 측정해야 합니다. 이
저장소의 로컬 검증은 원격 backup 또는 복구 리허설을 수행하지 않았습니다.

## 4. 장애 대응

| 증상 | 확인 | 조치 |
|---|---|---|
| ERP `/health` 실패 | process, listener, stderr, `X-Request-Id` | revision/port 충돌 확인 후 정상 재기동; 무관 process kill 금지 |
| `/health` 성공, PG 로그인 503 | `/api/v1/pg/health`, SSH 터널, `PG_*` | 터널/방화벽/자격증명 복구; SQLite 정상과 혼동 금지 |
| PG 로그인 후 조직 없음 | SQLite schema v5, `auth_identity`, 실제 membership | 숫자 ID/이메일로 자동 연결 금지; 소유권 확인 후 운영 repair |
| PG signup 후 초대 미수락 | PG account/session과 SQLite invitation/audit | 두 DB 비원자 구간으로 incident 기록; token/email 재검증 후 재수행, membership 없이는 접근 차단 유지 |
| SQLite busy/corrupt | 디스크, WAL, 장기 process, 최근 checksum | 쓰기 차단·원본 보존 후 검증된 backup으로 격리 복구; WAL 임의 삭제 금지 |
| 예약 :8080 미기동 | startup stderr, `DATABASE_URL`, 예약 DB schema | 별도 DB와 Prisma client/schema 확인; ERP DB로 우회 금지 |
| 예약 API 5xx | request log, DB connection, SMTP side effect | 트래픽 차단 후 예약 DB 일관성 확인; 중복 예약 직접 수정 금지 |
| 예약 legacy row 미표시 | nullable tenant/org/owner scope와 mapping inventory | 첫 사용자/이메일/숫자 ID 추측 금지; 검증된 소유권 승인 후 backfill |
| 동시 예약 충돌 | app 409와 `no_overlap_reservation_org` constraint | 실제 PG constraint/version 확인; app pre-check만으로 동시성 보장 주장 금지 |
| AI 실패 | provider/usage, key quota, Ollama | 정책 허용 범위에서 echo/Ollama fallback; 민감 데이터 외부 전송 금지 |
| 회계 불일치 | transaction/ledger/report/audit | incident로 격리하고 원본 보존; 운영 DB 직접 수정 금지 |
| audit invalid | verify 결과와 broken sequence | 보안 incident 선언, 원본/backup 보존, 쓰기 제한 |

## 5. 모니터링

- 세 서비스별 process restart, listener, liveness와 **별도** datastore readiness
- ERP SQLite 파일/디스크 사용량, WAL 증가, busy/error, migration 실패
- `perp_db` 및 예약 DB connection latency/error, pool 포화, storage, backup age
- API route별 latency/error와 `X-Request-Id`; 인증 실패/lockout, 403, 승인 거절
- 예약 중복 충돌, reminder/email 실패, scheduler 생존 여부
- Audit chain, finance transaction/ledger/report 합계, restore rehearsal 결과
- OpenRouter/Ollama latency, token/cost/result와 민감 등급 외부 전송 차단
- 각 저장소의 마지막 성공 backup과 checksum, 실제 RPO/RTO 측정치

P95와 오류율 임계치는 관측 도구와 정상 baseline을 확보한 뒤 환경별로 설정합니다.
계측되지 않은 목표를 달성했다고 보고하지 않습니다.
