# 운영 매뉴얼 (Operations Manual)

## 1. 시스템 구성

### 런타임 토폴로지

| 구성요소 | 역할 | 기본 주소/포트 | 영속 저장소 |
|---|---|---|---|
| `orbitflow-frontend` | Vite/React SPA; ERP와 예약 API 호출 | `127.0.0.1:5173` (dev) | 없음; 운영은 정적 `dist` |
| `orbitflow-backend` | Express ERP API, AI Gateway, audit chain | `127.0.0.1:8000` | SQLite + 원격 `perp_db` |
| `room-reservation` | 별도 Express/Prisma 예약 API | `localhost:8080` | 별도 `room_reservation` PostgreSQL |
| Ollama (선택) | 민감 데이터용 로컬 AI provider | `localhost:11434` | 모델 저장소(운영자가 별도 관리) |
| 로컬 Wiki 모델 서버 (선택) | LLM Wiki 컴파일·조사 전용 strict local provider | `WIKI_LOCAL_MODEL_CONFIG.base_url`의 numeric loopback origin만 | 모델 파일(운영자가 별도 관리) |
| 업로드 저장소 | 원증빙 원본, 문서 원본 | `ORBITFLOW_UPLOAD_DIR` (기본 `backend/src/uploads/`) | 영속 디스크 필수, DB와 같은 backup set |

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

### 로컬 Wiki 모델 (strict local, Echo fallback 없음)

LLM Wiki의 컴파일(ingest)·조사(query)·검토(lint) 작업은 범용 AI Gateway와 별도의
strict local provider만 사용합니다. `ORBITFLOW_AI_PROVIDER=echo`나 OpenRouter 설정을
상속하지 않으며, Echo/외부 provider로 fallback하지 않습니다. 설정은 서버 env 하나입니다.

```text
WIKI_LOCAL_MODEL_CONFIG={"base_url":"http://127.0.0.1:12345","model":"loaded-identifier","context_tokens":8192,"output_tokens":1024,"timeout_ms":120000,"temperature":0}
```

- `base_url`은 HTTP numeric loopback(`127.0.0.1` 또는 `[::1]`) origin만 허용합니다.
  DNS 호스트명, userinfo, path/query/hash, 외부 주소, redirect는 거부합니다.
- 서버가 호출하는 경로는 `/api/v0/models`와 `/v1/chat/completions` 둘뿐이며, 현재
  adapter는 LM Studio 호환 loaded metadata(`state:"loaded"`, 실제 `loaded_context_length`,
  정확한 `id`)를 요구합니다. `/v1`만 제공하는 임의 provider는 지원 범위가 아닙니다.
- API key 같은 비밀 필드는 받지도, 기록하지도 않습니다. 모델에 shell/file/URL-fetch/ERP
  도구 권한을 주지 않으며 tool call 응답은 거부합니다.
- env가 없거나 모델이 내려가 있으면 해당 작업은 `unavailable` 상태와 failure code로
  끝납니다. 원본 등록, 게시된 위키 읽기, 근거 없는 조사(`no_evidence`)는 모델 없이도
  계속 동작합니다. 모델 부재를 답변이나 게시물로 표시하지 않습니다.
- context 한도는 tokenizer가 아닌 보수적 바이트 상한 추정입니다. 입력이 loaded
  context를 넘으면 422이며 prefix만 잘라 처리하지 않습니다.

`server.js`는 기동 시 Wiki worker(`startWikiWorker`)를 시작하고 종료 시 `stop()`을
기다립니다. worker는 30초 maintenance와 queue 신호로 durable job을 처리하며 scope당
queued/running 20개, lease 120초, heartbeat 30초, 최대 3 attempts입니다. lease 판정은 DB
시각만 사용하므로 앱 호스트와 DB 시각 차이를 모니터링해야 합니다. 상세 계약은
`docs/knowledge-wiki-jobs-contract.md`와 `docs/knowledge-wiki-publication-interface.md`입니다.

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

### Schema 적용 순서 (SQLite 자동, PostgreSQL 수동)

SQLite additive migration은 `backend/src/config/migrations.js`의 번호 Set으로 적용되며
번호가 연속일 필요는 없습니다. 이번 기능군의 확정 번호와 순서는 다음과 같습니다.

| SQLite 번호 | 내용 |
|---|---|
| 9 | 회사 역할 정의·`membership.roles_version` CAS |
| 10 | 원증빙 staging/link 불변 guard와 실지출 metadata(`counterparty`, `occurred_at`, `input_currency`, `no_receipt_reason`) |
| 11 | 결재 draft/pending/withdrawn workflow, 양식, 첨부 snapshot 경계 |
| 12 | LLM Wiki `knowledge_*` 저장(원본 revision, page, job, change-set, publication, event) |
| 13 | CSV 지출 가져오기 upload/job/identity claim |
| 14 | Wiki 무효화(원본 변경·권한 회수 시 generation/fence 갱신) |

원격 `perp_db`는 앱이 적용하지 않으며 DBA가 `db/` 파일을 아래 순서로 한 번씩 적용합니다.
v13은 enum 값 추가만 담은 독립 commit이며, v14가 그 값을 사용하므로 두 파일을 한
transaction으로 합치면 안 됩니다. v12는 두 파일이며 `expenses` 다음 `expense_writer`입니다.

| 순서 | 파일 | 내용 |
|---|---|---|
| v11 | `perp_additions_v11_deadline_roles.sql` | `org.company_memberships.roles_version` |
| v12 | `perp_additions_v12_deadline_expenses.sql` → `perp_additions_v12_deadline_expense_writer.sql` | 원증빙 `accounting.journal_entry_files`, 실지출 metadata, `journal_entries.budget_id` |
| v13 | `perp_additions_v13_approval_states.sql` | `common.approval_status`에 `draft`, `withdrawn` 추가 (별도 commit) |
| v14 | `perp_additions_v14_approval_details.sql` | 결재 title/body/form_snapshot/version/predecessor, `org.approval_forms`, history |
| v15 | `perp_additions_v15_knowledge_wiki.sql` | `knowledge.*` Wiki 저장 |
| v16 | `perp_additions_v16_deadline_expense_imports.sql` | CSV 가져오기 upload/job/identity claim |
| v17 | `perp_additions_v17_analytics_exports.sql` | 분석 export 요청 metadata |
| v18 | `perp_additions_v18_knowledge_invalidation.sql` | Wiki 무효화 trigger, `orbitflow_wiki_invalidated` notify |

배포 대상 산출물에는 v11~v18 파일이 모두 있어야 하며, 하나라도 없으면 해당 기능의
schema 적용을 진행하지 않습니다. 어느 환경에도 위 파일을 이 문서 작성 과정에서 적용하지 않았습니다.
적용 전 각 파일의 `BEGIN/COMMIT` 경계와 `IF NOT EXISTS` 조건을 확인하고 실제 적용
결과를 backup ID와 함께 기록합니다.

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
| ERP `GET /api/v1/routes` | route wiring | HTTP 200, `prefix=/api/v1`, 현재 21개 고유 그룹 | 데이터 저장소 readiness 아님 |
| ERP `GET /api/v1/pg/health` | `perp_db` 연결/schema canary | HTTP 200, `status=ok`, `database=perp_db` | SQLite/예약 DB를 확인하지 않음 |
| ERP 인증된 업무 smoke | SQLite 업무 readiness | 승인된 테스트 계정으로 읽기 1건과 tenant/org 범위 확인 | 계정과 안전한 대상 endpoint 필요 |
| 예약 `GET /health` | 예약 프로세스 liveness | HTTP 200, `status=ok` | 호출 시 DB를 다시 질의하지 않음 |
| 예약 인증된 읽기 smoke | 예약 DB readiness | 승인된 principal로 공간 목록 등 읽기 성공 | 인증 계약과 별도 DB 필요 |
| SPA `GET /` 및 asset | 정적 release liveness | HTML과 fingerprint asset HTTP 200 | 두 API의 readiness 아님 |
| 인증된 `GET /analytics/kpis` 또는 `/pg/analytics/kpis` | 분석 원천 readiness | HTTP 200, metric별 `state`가 ready/empty이고 `unavailable`의 `reason`이 예상 범위(PG AI/audit는 `SOURCE_UNSUPPORTED`)인지 확인 | `SOURCE_QUERY_FAILED`는 그 원천 장애이며 0으로 표시되지 않음 |
| 인증된 Wiki root `GET /documents/wiki` 등 | Wiki 저장·권한 readiness | HTTP 200, `wiki:null` 또는 page 목록 | 모델 readiness가 아님; 모델 부재는 job `unavailable`로만 나타남 |
| 업로드 디렉터리 쓰기 검사 | 원증빙 저장 readiness | `ORBITFLOW_UPLOAD_DIR`에 ERP 계정이 `wx`로 파일 생성 가능 | 기존 원본 checksum 무결성은 별도 backup 검증 |

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
| 파일/객체 | `ORBITFLOW_UPLOAD_DIR` 아래 원증빙 원본(`receipts/<uuid>.<ext>`)과 문서 원본 | DB 레코드와 같은 복구 시점/manifest로 보존; 원본과 link는 posted 뒤 DB trigger로 수정·삭제가 거부되므로 backup에서도 checksum 대조 |
| 설정과 secret | 배포 설정의 secret 없는 사본, Secret Manager 버전/복구 정책 | DB dump에 secret을 넣지 않고 별도 접근통제 |
| 정적 release | 배포한 frontend `dist`와 backend revision 식별자 | DB backup과 code revision을 함께 기록 |

원증빙 원본은 `ORBITFLOW_UPLOAD_DIR`(기본 `backend/src/uploads/`) 아래 생성된 key로
저장되고, DB의 link(`transaction_evidence`, `approval_receipt_files`, PG
`accounting.journal_entry_files`, `org.approval_request_files`)가 원본을 가리킵니다.
파일 디렉터리와 SQLite/`perp_db`를 서로 다른 시점에 백업하면 link는 있는데 원본이 없는
상태가 되므로 같은 backup ID로 묶습니다. 원본 삭제 정책은 자동이 없습니다. 이 저장
구조가 법적 보존 기간 요건을 충족한다고 주장하지 않으며, 보존 기간과 폐기는 조직 정책과
별도 절차로 정합니다. `infra`의 MinIO volume은 애플리케이션 연결 근거가 없으므로 운영
저장소라고 가정하지 않습니다.

Wiki 지식은 SQLite `knowledge_*` / PG `knowledge.*`에 함께 저장되므로 별도 backup
대상이 아니지만, embedding·유사도 cache와 달리 게시된 page revision·citation·publication
receipt는 복구 대상 데이터입니다.

### 정기 정리 작업 (활성화·저장 volume·모니터 전송은 운영자 책임)

세 가지를 구분합니다. **활성화**는 env로 켜는 코드 내장 timer, **저장 volume**은 운영자가
마련하는 영속 디스크·backup, **모니터 전송**은 stdout 이벤트를 수집·알림하는 외부 collector입니다.
코드는 첫 번째만 제공하며, 어느 환경에서도 이 문서가 "운영 중"이라고 주장하지 않습니다.

| 대상 | 실행 방식 | 만료 기준 | 반환값과 재시도 |
|---|---|---|---|
| CSV 가져오기 원본·preview | ERP 프로세스 내장 timer(`ORBITFLOW_IMPORT_CLEANUP_STORES`로 opt-in) 또는 수동 one-shot `node scripts/cleanup_expense_imports.mjs legacy` / `perp_db` | 업로드 후 24시간; 새 preview를 만들어도 연장되지 않음. 만료 판정은 DB 시각이며 sweep과 무관하게 즉시 적용 | `{deleted,redacted}`; 재실행 안전. busy/timeout/실패는 즉시 재시도 없이 다음 tick |
| 원증빙 staging(미소비 임시 업로드) | 같은 내장 timer(`ORBITFLOW_RECEIPT_CLEANUP_STORES`로 **독립** opt-in). 내부적으로 기존 `cleanupLegacyReceipts()` / `cleanupPgReceipts()`만 호출 | token 24시간; 미소비 `writing|ready` staging만 | `{deleted,failed,shared}`; `failed>0`은 `unlink_failed`로 다음 tick 재시도, `shared>0`은 공유 참조 **보존**(운영자 확인 필요) |
| 분석 export 요청 | 별도 정리 없음 | `expires_at` 이후 다운로드 409 | 파일을 만들지 않으므로 디스크 정리 대상 아님 |

#### 내장 정리 timer (코드 내장, 두 종류 모두 기본 꺼짐)

`npm start`(`backend/src/server.js`)가 설정을 migrate 전에 검증하고, HTTP listen 성공 콜백에서만
**하나의** `setInterval`과 하나의 non-overlap guard를 설치합니다. 외부 cron·scheduler 프레임워크는
없지만 **선택 env를 비워 두면 그 종류는 비활성**이며 시작 이벤트에 그 상태가 남습니다. 잘못된
설정은 값을 노출하지 않는 고정 `IMPORT_CLEANUP_CONFIG` 오류로 기동을 거부합니다.

| env | 값 | 기본 |
|---|---|---|
| `ORBITFLOW_IMPORT_CLEANUP_STORES` | **CSV job만.** `legacy`, `perp_db`, `legacy,perp_db`(순서 무관, 공백 허용). 중복·알 수 없는·빈 토큰은 기동 거부 | 빈 값 = CSV 정리 비활성 |
| `ORBITFLOW_RECEIPT_CLEANUP_STORES` | **원증빙 staging job만.** 같은 선택 문법, CSV 선택과 독립. 한쪽을 켜도 다른 쪽이 켜지지 않음 | 빈 값 = 원증빙 정리 비활성 |
| `ORBITFLOW_IMPORT_CLEANUP_INTERVAL_MS` | 두 종류가 **공유하는** cadence(이름의 `IMPORT`는 역사적 접두어). 정수 1000..2147483647. 첫 실행은 기동 후 한 interval 뒤. Node `setInterval`이며 wall-clock/crontab 정렬이 아님. 다운타임 중 놓친 tick은 재생하지 않고 다음 tick이 현재 만료분을 처리 | 3600000 (1시간) |
| `ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS` | 두 종류가 공유하는 job별 worker 한도. 정수 100..interval_ms. 초기화/connect/cleanup/close 포함. PG는 connect·lock 대기 `min(5000,timeout)`, `statement_timeout`=timeout. 원증빙 전용 timeout 변수는 없음 | 30000 |
| `ORBITFLOW_UPLOAD_DIR` | 원증빙 선택 시 필수. API와 같은 **절대 경로의 기존 디렉터리**. 기동 시 trim·snapshot하며 누락/상대/비디렉터리는 기동 거부. worker는 DB 정리 전 존재를 재확인하고 없으면 `store_unavailable`(상태 변경 없음). 영속성·mount·ACL·backup은 운영자 책임 | 없음 |

- legacy를 어느 종류에서든 선택하면 절대 경로 `ORBITFLOW_DATABASE_FILE`이 필수(`:memory:`/상대
  기본값 불가). 파일이 없으면 `store_unavailable`이며 생성하지 않습니다. perp_db는
  protocol/host/port/user/database를 모두 담은 `DATABASE_URL` 또는 완전한
  `PG_HOST/PG_PORT/PG_DATABASE/PG_USER`(+`PG_PASSWORD`)가 필수이며 localhost/55432 기본값을 빌리지
  않습니다. 선택된 연결 설정과 upload root는 기동 시 snapshot됩니다.
- tick마다 job 순서는 선택된 CSV store(설정 순서) → 선택된 원증빙 store(설정 순서), 최대 4개
  순차 실행. job마다 전용 native worker thread 하나가 해당 cleanup 함수만 import하고 자기 SQLite/PG
  자원을 닫습니다. 겹치는 tick은 enqueue 없이 `skipped/overlap`만 기록합니다. HTTP pool과 기존
  cleanup service transaction은 바뀌지 않습니다.
- SIGINT/SIGTERM: 공유 interval 정지 → 진행 중 worker abort·실제 종료 대기 → HTTP `server.close` →
  exit 0. 정지 뒤 남은 종류/store는 시작되지 않습니다.
- **multi-process 배포는 한 프로세스만 두 선택 변수를 설정**하고 나머지는 모두 비워 둡니다. 프로세스
  내 non-overlap은 분산 lease가 아니며 저장소 경합 보호는 기존 DB lock이 담당합니다.
- 수동 CSV CLI는 one-shot이며 두 번째 scheduler가 아닙니다. 원증빙 정리는 수동 CLI 없이 timer 또는
  코드 호출로만 실행됩니다.

정리 대상과 보존:

- CSV: `expense_import_uploads`/`accounting.expense_import_uploads`의 만료 raw bytes와
  `expense_import_jobs`/`accounting.expense_import_jobs`의 비감사 snapshot(superseded/invalid/ready/
  completed, upload 누락 preview 포함)만. SQLite `BEGIN IMMEDIATE`, PG는 commit과 같은 회사 lock 뒤
  만료 재검사. 진행 중 import/commit은 보존되고 완료 snapshot은 audit-only가 되며
  ledger/replay/result/identity/hash/건수는 남습니다.
- 원증빙: `receipt_upload`/`files.receipt_uploads`의 만료된 **미소비** `writing|ready` 행만. SQLite
  `BEGIN IMMEDIATE`, PG `FOR UPDATE SKIP LOCKED`(lock된 행은 다음 tick). 그 행이 가리키는 생성된
  `receipts/<UUID>.(jpg|jpeg|png|pdf)` 경로만 검증 후 삭제하고 상태를 deleted로 바꿉니다. 디렉터리
  열람·재귀 sweep은 없습니다. 활성 ready/writing, 소비된 원본, 공유 `file_object`/`files.objects`
  참조, 장부/link/감사/replay, 무관한 파일은 보존되며 공유 행은 `SHARED_OBJECT_PRESERVED`로 남습니다.
- 원증빙 파일 삭제는 DB transaction으로 되돌릴 수 없습니다. unlink 뒤 DB commit 전에 중단되면 만료된
  미소비 bytes만 사라진 상태이며 다음 tick이 파일 없는 staging을 안전하게 마무리합니다. DB rollback이
  삭제된 staging bytes를 복원한다고 표현하지 않습니다.

#### 모니터링 이벤트 (stdout JSON, 전송·보존은 외부)

호환을 위해 두 종류 모두 `event=expense_import_cleanup`, `at`(ISO)입니다. 운영 감사 기록이지 tenant
DB audit 행이 아니며, 예외 메시지·stack·CSV 원문·파일명·경로·자격증명·SQL·tenant/actor 내용은
포함되지 않습니다. 고정 metadata와 건수만 있습니다.

| 시점 | 필드 |
|---|---|
| 기동 | `status: scheduled|disabled`, `stores`(CSV), `receipt_stores`, `interval_ms`, `timeout_ms`. `scheduled`는 한 종류라도 선택됐다는 뜻이므로 **선택별로 따로** 감시 |
| job 시작 | `started`, `kind: imports|receipts`, `store: legacy|perp_db` |
| CSV 성공 | `succeeded`, `kind:imports`, `store`, `duration_ms`, `deleted`, `redacted` |
| 원증빙 결과 | `kind:receipts`, `store`, `duration_ms`, `deleted`, `failed`, `shared`. `failed>0`이면 `status:failed`, `reason:unlink_failed`, `retry:next_tick`(세 건수 유지). `failed=0`이면 `succeeded`; `shared>0`은 참조 보존이며 전부 제거됐다는 뜻이 아님 |
| 실패 | `failed`, `kind`, `store`, `duration_ms`, `reason`, `retry:next_tick`. 확인된 결과가 없으면 건수 없음 |
| 취소 / 겹침 / 종료 | `cancelled {kind,store,duration_ms}` / `skipped, reason:overlap` / `stopped` 1회 |

`reason`은 `busy|timeout|store_unavailable|cleanup_error|worker_error|unlink_failed`만입니다.
실패·timeout 시 즉시 재시도와 fallback은 없고 남은 **설정된** job은 계속 진행하며 다음 tick에
재시도합니다. hard timeout 뒤에는 성공이 미확인일 수 있어 건수를 주장하지 않으며 다음 tick의
idempotent 재실행이 안전합니다. unlink 실패는 해당 staging의 `cleanup_error`에 `UNLINK_FAILED`로 남고
운영자 조치 뒤 재시도됩니다. collector/supervisor는 stdout을 보존하고 `failed`, 예상 밖·누락된
선택, 반복 `skipped`, cadence + 선택 job 실행 허용치 안에 종류·store별 `succeeded`가 없는 경우에
알림을 보내야 하며 `shared>0`은 따로 검토합니다. **알림 전송, 로그 보존, 실제 활성화는 이 코드가
설치하지 않습니다.**

- CSV 정리 뒤 job은 `content_expired:true`가 되며 미완료 job의 rows/commit은 410
  `IMPORT_CONTENT_EXPIRED`입니다. 만료는 sweep 전에도 즉시 적용되므로 사용자 공지는 "24시간"
  기준입니다. 완료 job의 같은 key replay는 정리 뒤에도 원래 결과를 반환합니다.
- 원증빙 cleanup 함수를 코드에서 직접 호출할 때는 자체 transaction을 열므로 도메인 transaction 안에
  중첩하지 않습니다.
- DB live content 교체는 DB page/WAL/filesystem/backup의 forensic 소거가 아닙니다. upload root
  존재 검증은 volume/mount/영속성 보증이 아닙니다. DB/WAL/파일/backup/접근 보존 정책은 운영자가
  별도로 승인하며 법적 보존 충족을 주장하지 않습니다. 이 runtime은 활성화 전에 코드·설정·종료
  동작 검증이 필요하며, 이 문서는 검증 완료나 운영 활성화를 주장하지 않습니다.

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
| Wiki job `unavailable` | `failure_code`, `WIKI_LOCAL_MODEL_CONFIG`, 로컬 모델 서버 `/api/v0/models`의 loaded 상태 | 모델 재기동 후 사용자가 명시 retry(최대 3 attempts); Echo/외부 provider로 대체 금지. `SOURCE_REVOKED`는 원본 변경·권한 회수이므로 새 job 필요 |
| Wiki 게시 409 | change-set `manifest_hash`, expected head, 원본 freshness | 초안을 다시 검토하고 새 digest로 게시; 서버 digest를 우회한 재계산 금지 |
| CSV commit 410/409 | job `content_expired`, `IMPORT_ACCOUNT_CHANGED`, `IMPORT_IDENTITY_CHANGED` | 화면 안내대로 파일을 다시 선택해 새 검토를 시작하도록 안내; 클라이언트 행을 commit에 재전송하지 않음, partial success 없음 |
| 원증빙 다운로드 404/403 | parent link, 결재 reader 경계, 파일 존재 | 원본 경로 노출·inline 렌더 금지; `apiBlob` 경로만 사용, 누락 원본은 backup에서 복구 |
| 분석 카드 `unavailable` | metric `reason` (`SOURCE_QUERY_FAILED`, `MIXED_CURRENCY`, `CURRENCY_MISMATCH`, `SOURCE_UNSUPPORTED`) | 쿼리 실패만 장애; 통화 혼합은 데이터 상태, PG AI/audit 미지원은 정상. 값을 0으로 대체하지 않음 |
| 역할 저장 409 | `expected_version`/`expected_roles_version` stale, 마지막 전체 관리자 보호 | 최신 버전을 다시 읽고 재시도; 관리자 없는 회사는 recovery-required로 표시하고 SQL로 승격 금지 |
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
- `expense_import_cleanup` stdout 이벤트: 기동 `stores`/`receipt_stores` 선택 상태, 종류(`imports`/
  `receipts`)·store별 `succeeded` cadence, `failed` reason 분포(`unlink_failed` 포함), `shared>0`
  발생, `skipped/overlap` 반복 (위 정기 정리 절 참조)
- Wiki worker: scope별 queued/running 수(한도 20), lease 만료·reclaim 횟수, `unavailable`
  failure code 분포, 앱 호스트와 DB 시각 차이, 로컬 모델 서버 loaded 상태
- 분석 API의 metric `unavailable` reason 분포와 413 `EXPORT_LIMIT_EXCEEDED` 빈도
- 410 `IMPORT_CONTENT_EXPIRED`, 409 idempotency/CAS 충돌 빈도 (정상 동작이지만 급증은 클라이언트 결함 신호)

P95와 오류율 임계치는 관측 도구와 정상 baseline을 확보한 뒤 환경별로 설정합니다.
계측되지 않은 목표를 달성했다고 보고하지 않습니다.

## 6. 운영자가 알아야 할 도메인 계약

이 절은 화면 뒤에서 동작하는 규칙을 운영 관점에서 요약합니다. 정확한 DTO는 각 계약
문서를 따릅니다.

### 버전 토큰과 idempotency

| 대상 | 토큰 | 규칙 |
|---|---|---|
| 역할 정의 PATCH/DELETE | `expected_version` | stale 409, 쓰기 없음, 초안 보존. 권한이 먼저 사라졌으면 403 |
| 회원 역할 교체 | `expected_roles_version` (`membership.roles_version`, PG `company_memberships.roles_version`) | 일반 membership version과 독립 |
| 결재 요청 | 요청 `version`; 종결 원본은 불변, 재상신은 `predecessor_id`가 연결된 새 draft | 반려 사유 필수, 단일 terminal decision |
| Wiki 원본/페이지 | `expected_version` (Wiki source CAS), 원본 record의 `version`은 별도 | 게시는 `manifest_hash` + `confirmed:true` + `Idempotency-Key` |
| CSV 적용 | `POST .../imports/:jobId/commit` 본문 `{}` + `Idempotency-Key` | 같은 key+job은 기존 결과, 다른 job 409, CSV/rows 재전송 400 |
| Wiki job 접수 | `POST .../wiki/jobs` + `Idempotency-Key` | 신규 202, 동일 replay 200, 다른 요청 409 |
| PG 원증빙 소비 | 부모 `xmin::text` | 기본 1이나 추정 xmin을 합성하지 않음 |

### 원증빙 불변성과 안전한 다운로드

- 업로드는 JPEG/PNG/PDF 원본 bytes만, 개별 10MiB, 부모당 5개/25MiB. 검증은 형식·decode·
  암호화 PDF 거부이며 malware scan이나 OCR이 아닙니다.
- 소비된 원본과 link는 DB trigger로 update/delete가 거부됩니다. 사후 첨부는 감사된
  append만 가능합니다.
- 다운로드는 부모 결재/전표 read 권한을 함께 검증하는 `/.../:id/receipts/:fileId`만
  제공하며 `Content-Disposition: attachment`, `nosniff`, `private, no-store`입니다. URL에
  토큰을 넣지 않고 SPA는 `apiBlob`으로 받은 objectURL을 사용 뒤 revoke합니다. 원본 inline
  미리보기는 제공하지 않습니다.
- legacy 결재 첨부는 requester와 실제 배정된 reader만, PG는 requester 또는
  authorized-decider pool만 읽습니다. 회사 관리자라는 이유로 우회하지 않습니다.

### 분석 단위와 상태

- metric `state`는 `ready/empty/forbidden/disabled/unavailable`로 구분되며 실패를 0으로
  바꾸지 않습니다. 권한 없는 원천은 SQL을 실행하지 않고 `forbidden`입니다.
- PG 금액 단위는 `ledger_decimal`(장부 그대로), legacy는 `transaction_record.currency`이며
  `amount_minor/100`입니다. 여러 통화가 섞이면 `MIXED_CURRENCY`로 unavailable, 환율 변환은
  없습니다. UI가 '원'을 강제하지 않습니다.
- 기간은 `[from,to)`, 기본 tz `Asia/Seoul`, 기본 이번 달 첫날부터 다음 달 첫날. current_snapshot
  지표는 조회 시점 상태이며 과거 말일 상태가 아닙니다. `series`는 비어 있고 추세를 합성하지
  않습니다.
- export는 다운로드 시 현재 데이터를 재조회합니다(`requery_on_download:true`). 100,000행
  초과는 413이며 조용한 절단이 없습니다.

### 저장소(native/legacy)별 범위 차이

| 영역 | legacy (SQLite 조직) | PG (`pg:<company_id>`) |
|---|---|---|
| 역할 scope | all/department/project/self 유효 union | 회사 all만; department/self grant를 합성하지 않음 |
| 결재 결정자 | 실제 배정된 순차 step + `approval.decide`; hold는 열린 상태 | 회사 non-draft authorized-decider pool |
| 분석 AI/audit 카드 | 자기 AI 사용량, tenant-wide audit(`scope.rows=tenant_all`) | `SOURCE_UNSUPPORTED`로 unavailable |
| 개인 Vault/Wiki owner | tenant/org 조건 포함 | 회사 선택과 무관한 인증 사용자; 회사 전환은 요청을 무효화하지만 소유자를 바꾸지 않음 |
| 지식 그래프 허브 | 노트/문서 | `project:42`는 kind `space`인 별도 entity이며 document 42와 다름 |
| Wiki root | `/vault/wiki`, `/documents/wiki` | `/pg/vault/wiki`, `/pg/documents/wiki` |

한 저장소의 결과를 다른 저장소의 기준으로 표시하거나, 실패 시 다른 저장소로 fallback하지
않습니다.

### Wiki 게시·원본 회수

- 컴파일과 조사는 초안만 만듭니다. 일반 목록/그래프/검색에는 초안이 나오지 않고 검토
  화면에서만 보입니다. 게시는 사용자가 서버 digest를 확인한 정확한 변경 묶음에만 적용됩니다.
- 상태는 세 축으로 나뉩니다. 변경 묶음(change-set)은 draft/published/rejected, 게시된
  페이지는 published/withdrawn, 최신성(freshness)은 current/stale/unavailable이며 서로 별개입니다.
  원본이 바뀌면 전이 dependency까지 stale, 원본 삭제·권한 회수는 그 독자에게 파생 정보도
  unavailable이며 reason은 `SOURCE_REVOKED`입니다. 비동기 worker가 멈춰도 read/publish 시
  revision·권한 검사가 차단합니다.
- 유효한 인용은 추적 가능성이며 사실성 보증이 아닙니다. 화면과 문서에서 "검증됨"으로
  표현하지 않습니다.
