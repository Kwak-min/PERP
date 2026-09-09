# OrbitFlow Backend

Node.js 22.5+ 및 Express 5 기반 OrbitFlow ERP API입니다. 루트 전체 workspace는
Vite 요구 조건 때문에 Node.js 22.12+를 사용합니다.

## 데이터 경계

이 API는 단일 SQLite 서비스가 아닙니다.

- `ORBITFLOW_DATABASE_FILE`: 대부분의 ERP 업무 데이터를 저장하는 SQLite 파일.
  기동 시 `src/config/migrate.js`가 schema와 additive migration을 적용합니다.
  `src/config/migrations.js`는 번호 Set으로 적용 여부를 판단하므로 비연속 번호가
  허용됩니다. 이번 기능군: 9 역할 CAS, 10 원증빙·실지출, 11 결재 workflow, 12 Wiki
  저장, 13 CSV 가져오기, 14 Wiki 무효화.
- `ORBITFLOW_UPLOAD_DIR`: 원증빙 원본(`receipts/<uuid>.<ext>`)과 문서 원본 저장 경로.
  기본값은 `src/uploads/`이며 운영에서는 영속·백업 대상 volume을 지정합니다. 소비된
  원본과 DB link는 trigger로 수정·삭제가 거부되며 자동 삭제 정책은 없습니다.
- `DATABASE_URL` 또는 `PG_*`: PostgreSQL 18 `perp_db` 인증 슬라이스. 기본 예시는
  SSH 터널의 `127.0.0.1:55432`를 가리킵니다. SQLite와 병행 사용됩니다. PG subject와
  운영 사용자의 연결은 SQLite migration v5 `auth_identity`가 소유합니다. 앱은 PG DDL을
  적용하지 않으며 `db/perp_additions_v11` → v12(`expenses` 다음 `expense_writer`) →
  v13(enum, 독립 commit) → v14 → v15 → v16 → v17 → v18을 DBA가 순서대로 한 번씩
  적용합니다.
- `Reservation/backend`: 별도 프로세스와 별도 PostgreSQL을 쓰며 이 workspace에
  포함되지 않습니다.

`infra/docker-compose.yml`의 `orbitflow` PG 16 컨테이너는 로컬 개발 보조
인프라이며 기본 `perp_db` 설정과 이름, 사용자, 포트가 일치하지 않습니다.
운영 배포 명세나 원격 DB 복제본으로 취급하지 마십시오.

## 실행

```bash
npm ci
cp .env.example .env            # 실제 secret은 .env 또는 Secret Manager에만 입력
npm run migrate
npm run dev
```

루트에서는 `npm run dev:backend`를 사용할 수 있습니다. 기본 listener는
`127.0.0.1:8000`입니다.

- Liveness: `GET /health`
- Route catalog: `GET /api/v1/routes` (현재 21개 그룹)
- PostgreSQL connectivity: `GET /api/v1/pg/health`
- API prefix: `/api/v1`

`GET /health`는 DB를 질의하지 않으므로 readiness가 아닙니다. 정상 `server.js`
기동은 listener 전에 SQLite migration을 완료하지만, PG bearer를 허용하기 전에
migration v5와 `auth_identity` table/index 적용을 확인해야 합니다. 배포 readiness에는
`/api/v1/pg/health`와 인증된 SQLite 업무 smoke test가 모두 필요합니다. 원격
`perp_db`가 없어도 비-UUID 레거시 SQLite 인증 경로와 liveness는 기동할 수 있지만,
PostgreSQL 로그인과 UUID 세션 요청은 사용할 수 없습니다.

PG 세션 만료는 기존 `auth.sessions.login_at`과 `ORBITFLOW_SESSION_TTL`로 판정하므로
별도 PG migration은 없습니다. 기존의 숫자 ID 기반 membership은 자동 연결하지
않습니다. 운영자가 계정 소유권을 독립적으로 확인한 뒤 `auth_identity`와 membership을
복구해야 합니다. PG signup 뒤 SQLite 초대 수락은 서로 다른 DB라 atomic하지 않으며,
중간 실패 시 계정만 남을 수 있지만 membership이 없어서 접근은 fail closed됩니다.

## 환경과 secret

`.env.example`의 `OPENROUTER_API_KEY`, `ORBITFLOW_WEBHOOK_SECRET`, `PG_PASSWORD`
등 실제 값은 커밋, 이미지, 로그, frontend `VITE_*` 변수에 넣지 않습니다. 운영에서는
개발 fallback 값에 의존하지 말고 Secret Manager에서 revision별로 주입합니다.

## 도메인 계약 문서

| 문서 | 내용 |
|---|---|
| `src/services/expenses.contract.md` | KRW 실지출 입력, 기존 장부 원천, metadata |
| `src/services/receipt-files.contract.md` | 원증빙 업로드/소비/다운로드, 불변 guard, cleanup, 보안 pin과 LGPL 고지 |
| `src/services/expense-import.contract.md` | CSV upload/preview/rows/commit, identity, 24시간 만료와 cleanup |
| `src/services/analytics.contract.md` (+ `.d.ts`) | KPI/보고서/export DTO, 상태 코드, 단위(`ledger_decimal`), 100,000행 한도 |
| `docs/knowledge-wiki-jobs-contract.md` | Wiki job/worker/strict local provider (최종 통합 산출물 필수) |
| `docs/knowledge-wiki-publication-interface.md` | change-set 검토·게시·무효화·SSE (최종 통합 산출물 필수) |

### 정리 작업

CSV 가져오기 원본과 원증빙 staging 정리는 `server.js`에 내장된 **하나의** timer가 실행하며 두
종류 모두 **기본 비활성**입니다. 현재 tree에 timer·전용 worker와 Wiki/정리 공동 lifecycle 배선이
포함됩니다. 격리 검증 범위는 `docs/runtime-integration-task29.md`를 참조하며, 배포 대상의
설정·종료 검증과 운영 활성화는 별도 gate입니다.

```bash
ORBITFLOW_IMPORT_CLEANUP_STORES=legacy,perp_db    # CSV job. 빈 값 = 비활성
ORBITFLOW_RECEIPT_CLEANUP_STORES=legacy,perp_db   # 원증빙 staging job. CSV와 독립, 빈 값 = 비활성
ORBITFLOW_IMPORT_CLEANUP_INTERVAL_MS=3600000      # 두 종류 공유 cadence, 1000..2147483647
ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS=30000         # 두 종류 공유 job별 worker 한도, 100..interval
ORBITFLOW_UPLOAD_DIR=/abs/existing/upload/root    # 원증빙 선택 시 필수, API와 같은 절대 경로

# 수동 one-shot (timer와 별개, CSV만)
node scripts/cleanup_expense_imports.mjs legacy     # {store,deleted,redacted}
node scripts/cleanup_expense_imports.mjs perp_db
```

한 프로세스만 선택 변수를 설정합니다. legacy는 절대 경로 `ORBITFLOW_DATABASE_FILE`, perp_db는
완전한 `DATABASE_URL` 또는 `PG_HOST/PG_PORT/PG_DATABASE/PG_USER`가 필요하며 기본값을 빌리지
않습니다. tick마다 CSV store → 원증빙 store 순으로 최대 4개 job이 순차 실행되고 job마다 전용
worker thread가 기존 `cleanupLegacyExpenseImports()`/`cleanupPgExpenseImports()` 또는
`cleanupLegacyReceipts()`/`cleanupPgReceipts()`만 호출합니다.

결과는 stdout JSON `event=expense_import_cleanup`로만 남습니다. 기동 `status`, `stores`,
`receipt_stores`; job별 `kind: imports|receipts`, `store`, `started/succeeded/failed/cancelled`;
CSV 건수 `deleted,redacted`; 원증빙 건수 `deleted,failed,shared`(`failed>0`은 `unlink_failed`로
다음 tick 재시도, `shared>0`은 공유 참조 보존이므로 운영자 검토); 전역 `skipped/overlap`, `stopped`.
수집·알림·보존은 배포 환경이 담당합니다. 실패는 즉시 재시도 없이 다음 tick, `SQLITE_BUSY`는
성공이 아닙니다.

두 정리는 24시간 만료된 임시 입력만 지우며 장부·결재·소비된 원증빙 원본·공유 파일·identity
claim·감사는 건드리지 않습니다. 원증빙 파일 삭제는 DB rollback으로 복원되지 않고, 이 정리는
DB/WAL/backup의 forensic 소거나 법적 보존 충족이 아닙니다. `.env.example`의 두 opt-in 빈 기본값과
주석 예시, `WIKI_LOCAL_MODEL_CONFIG` 예시는 백엔드 단위가 관리합니다.

### LLM Wiki 로컬 모델

`WIKI_LOCAL_MODEL_CONFIG`(JSON: `base_url`, `model`, `context_tokens`, `output_tokens`,
`timeout_ms`, `temperature`)만 Wiki 컴파일·조사에 사용됩니다. `base_url`은 numeric
loopback origin만 허용되고 `ORBITFLOW_AI_PROVIDER`/Echo/OpenRouter를 상속하지 않습니다.
설정이 없으면 새 모델 의존 job은 `unavailable`이며 원본 등록·게시된 위키 읽기·`no_evidence`
조사는 계속 동작합니다. 빈 설정은 scheduler disable이 아닙니다. worker는 `legacy`/`pg`의
기존 job을 조회하고 저장된 모델 설정으로 재개할 수 있습니다. job이 없으면 idle, PG 연결
실패는 저장소 unavailable이며 Wiki 전용 운영 store 선택/disable env는 없습니다.
`server.js`는 설정 검증·migration 뒤 listen 성공 시 두 worker를 시작합니다. SIGINT/SIGTERM에
둘의 stop과 HTTP close를 즉시 요청하고, worker 종료와 기존 HTTP drain을 모두 기다린 뒤
SQLite/PG를 닫아 자연 종료합니다(정상 0, 오류 1). 강제 HTTP drain timeout은 없으며 lease
판정은 DB 시각입니다.

## 개인 AI API 키

설정 메뉴의 **AI API 키** (`/settings/ai-key`)에서 개인 OpenRouter 키를 저장·교체·삭제하고
연결 테스트를 실행합니다. 연결 테스트는 짧은 합성 문장만 전송하며 소액 과금될 수
있습니다. 문서, 기억, 개인 Vault는 조회하지 않습니다. 일반 대화 패널은 Vault 제외
계약 정비 전까지 비활성 상태이며, 키 등록만으로 대화 UI가 활성화되지는 않습니다.

서버의 `ORBITFLOW_AI_KEY_ENCRYPTION_KEY`에 암호학적 난수 32바이트를 Base64로
인코딩한 값을 Secret Manager에서 주입해야 합니다. 로컬에서 생성하는 예:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

생성값은 비밀 설정에 직접 보관하고 채팅·커밋·로그·`VITE_*`에 넣지 않습니다. 매 기동마다
새로 생성하면 기존 키를 복호화할 수 없습니다. 미설정/잘못된 길이/인증 태그 불일치는
저장 또는 사용을 503으로 차단합니다. 마스터 키를 바꾸려면 기존 값을 안전하게 유지한
계획된 이전이 필요하며, 이 버전에는 재암호화 도구가 없으므로 기존 개인 키를 삭제하고
새 마스터 키에서 다시 입력해야 합니다. 삭제는 암호화 설정이 없어도 가능합니다.

SQLite additive migration v6의 `ai_user_key`는 AES-256-GCM 암호문, 매 저장마다 새로운
96비트 nonce, 인증 태그만 저장합니다. 인증 부가정보는 tenant/org/운영 user/provider에
묶여 다른 소유자의 암호문을 복사해도 사용할 수 없습니다. PG 로그인도 `auth_identity`의
운영 사용자 UUID를 키 소유자로 사용하며 외부 숫자 ID/이메일로 다른 사용자의 키를 선택하지 않습니다.
PG 회사 선택에서는 실제 PG 회사 권한을 검증한 뒤 `pg:<company_id>` 저장 namespace를
사용합니다. 이것은 SQLite 조직/소속 생성이나 역할 승격이 아니며 SQLite membership이
없는 PG 사용자도 명시적 권한이 있으면 이용할 수 있습니다. 키는 선택 조직/회사별 개인
설정이며 관리자라도 다른 사용자의 키나 등록 상태를 조회하지 못합니다.

- `GET /api/v1/agent/api-key`: `{provider, configured, model}`만 반환합니다. 등록됨은 연결
  성공을 뜻하지 않습니다. `model`은 `ORBITFLOW_EXTERNAL_MODEL`입니다.
- `PUT /api/v1/agent/api-key`: `{api_key: string}`만 허용하며 기존 키를 교체합니다.
- `DELETE /api/v1/agent/api-key`: 암호문/nonce/tag를 비우고 soft-delete합니다.
- `POST /api/v1/agent/api-key/test`: 본인 저장 키로만 실제 HTTP 요청합니다. 실패 시 로컬
  폴백을 연결 성공으로 보고하지 않습니다.

PG 회사 선택 시 동일한 계약을 `/api/v1/pg/agent/api-key` 및 `/test`에서 제공합니다.
프런트엔드는 선택된 `pg:` 회사를 기준으로 PG 경로를 사용하고, 레거시 조직 선택은
기존 `/agent/api-key` 경로를 사용합니다. 실패 시 다른 조직/저장소로 폴백하지 않습니다.

레거시 API는 운영 조직 소속, agent 모듈과 `agent.chat` 권한을 요구합니다. PG API는
검증된 PG 세션과 정확한 `X-Org-Id: pg:<company_id>`, PG 회사에 기록된 `agent.chat`
권한 및 agent 모듈을 요구합니다. `is_admin` 또는 레거시 owner 권한만으로 PG 권한을
부여하지 않습니다. 개인 키가 있으면
허용된 AI 요청에서 서버 기본 키보다 우선하며, 삭제 후에는 서버 기본 설정을 따릅니다.
민감·기밀·알 수 없는 데이터 등급 또는 로컬 모델 정책은 항상 로컬만 사용합니다.
키 저장은 개인 노트의 외부 전송 동의가 아닙니다. 노트 의미 분석은 별도의 로컬 경로를
사용하며, 외부 분석을 추가하려면 명시적 전송 동의와 서버 측 등급 정책을 지켜야 합니다.

운영 입력 화면과 API는 HTTPS로 제공하고, 프록시/APM에서 요청 본문과 Authorization
헤더를 수집하지 마십시오. 감사로그는 등록/삭제 메타데이터만 기록합니다. 삭제해도 과거
암호화 백업/WAL의 복사본이 자동 소거되지는 않으므로 유출 의심 시 OpenRouter에서도 키를
폐기하고 조직의 백업 보존 정책을 적용하십시오.

## 검증

```bash
# backend package
npm test

# repository root: 임시 SQLite/임의 포트 실제 기동 후 자체 정리
node scripts/check_local_startup.mjs
```

기능별 격리 테스트(`tests/deadline-*.test.js`, `*-native.integration.mjs`)는 루트의
`node scripts/run_deadline_isolated.mjs node --test <파일>`로 실행합니다. runner는
`DATABASE_URL`/`PG_*`/provider key/`NODE_OPTIONS`를 비우고 임시 DB·포트만 넘깁니다.
native PostgreSQL 검증은 `--pg-bin <pgsql/bin>`으로 격리 인스턴스를 지정합니다.

Backend 테스트는 격리된 임시 SQLite를 사용합니다. 테스트 개수는 변경될 수 있으므로
고정 개수 대신 명령의 단일 실행 exit code와 출력된 pass/fail을 릴리스 증거로
보존합니다. 이 검증은 원격 `perp_db`, 예약 PostgreSQL, SMTP, 외부 AI provider의
운영 readiness를 증명하지 않습니다.
