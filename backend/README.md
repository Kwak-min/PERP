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
