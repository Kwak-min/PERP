# OrbitFlow Backend

Node.js 22.5+ 및 Express 5 기반 OrbitFlow ERP API입니다. 루트 전체 workspace는
Vite 요구 조건 때문에 Node.js 22.12+를 사용합니다.

## 데이터 경계

이 API는 단일 SQLite 서비스가 아닙니다.

- `ORBITFLOW_DATABASE_FILE`: 대부분의 ERP 업무 데이터를 저장하는 SQLite 파일.
  기동 시 `src/config/migrate.js`가 schema와 additive migration을 적용합니다.
- `DATABASE_URL` 또는 `PG_*`: PostgreSQL 18 `perp_db` 인증 슬라이스. 기본 예시는
  SSH 터널의 `127.0.0.1:55432`를 가리킵니다. SQLite와 병행 사용됩니다. PG subject와
  운영 사용자의 연결은 SQLite migration v5 `auth_identity`가 소유합니다.
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
- Route catalog: `GET /api/v1/routes` (현재 19개 그룹)
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

Backend 테스트는 격리된 임시 SQLite를 사용합니다. 테스트 개수는 변경될 수 있으므로
고정 개수 대신 명령의 단일 실행 exit code와 출력된 pass/fail을 릴리스 증거로
보존합니다. 이 검증은 원격 `perp_db`, 예약 PostgreSQL, SMTP, 외부 AI provider의
운영 readiness를 증명하지 않습니다.
