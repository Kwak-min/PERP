# OrbitFlow

작은 조직의 업무, 회계, 문서, 자산, 인사, 회의실 예약과 개인화 AI Agent를
하나의 운영 흐름으로 연결하는 웹 애플리케이션입니다.

## 실행 토폴로지

OrbitFlow는 런타임 서비스 3개와 서로 다른 데이터 저장소를 사용합니다.

| 서비스 | 위치 | 기본 주소 | 데이터 의존성 |
|---|---|---|---|
| ERP API | `backend/` | `http://127.0.0.1:8000` | 로컬 SQLite + 원격 `perp_db` PostgreSQL 인증 슬라이스 |
| Web SPA | `frontend/` | `http://127.0.0.1:5173` (개발) | ERP API + 예약 API |
| 예약 API | `Reservation/backend/` | `http://localhost:8080` | 별도 `room_reservation` PostgreSQL |

루트 npm workspace에는 `backend`와 `frontend`만 포함됩니다. 예약 API는 별도
패키지이므로 그 디렉터리에서 따로 설치, 빌드, 기동해야 합니다. `infra/docker-compose.yml`은
PG 16/Redis/MinIO를 띄우는 로컬 개발 보조 파일일 뿐 서비스 배포 명세가 아니며,
원격 PostgreSQL 18 `perp_db` 또는 예약 DB를 대신하지 않습니다.

## 기술 스택

- Backend: Node.js (전체 workspace는 22.12+), Express 5, SQLite (`node:sqlite`), PostgreSQL, Zod
- Frontend: Vite 8, React 19, React Router 7, TypeScript strict, Zod
- Reservation: Express 4, TypeScript, Prisma, PostgreSQL
- AI Gateway: OpenRouter, Ollama, deterministic echo adapter
- Browser QA: Playwright with installed stable Chrome

## 로컬 설치와 기동

각 `.env.example`을 런타임 `.env`로 복사하고 실제 값은 로컬 환경 또는 Secret
Manager에서만 주입합니다. `VITE_*` 값은 브라우저에 공개되므로 secret을 넣지 않습니다.

```bash
# ERP API + Web SPA (root workspace)
npm ci
npm run dev:backend             # terminal 1, :8000
npm run dev                     # terminal 2, :5173

# 예약 API (root workspace에 포함되지 않음)
cd Reservation/backend
npm ci
npm run db:generate
npm run dev                     # terminal 3, :8080; DATABASE_URL의 DB가 먼저 필요
```

- ERP liveness: `GET http://127.0.0.1:8000/health`
- ERP route catalog: `GET http://127.0.0.1:8000/api/v1/routes` (현재 19개 그룹)
- `perp_db` connectivity: `GET http://127.0.0.1:8000/api/v1/pg/health`
- Reservation liveness: `GET http://127.0.0.1:8080/health`

`/health` 성공은 프로세스 liveness이며 모든 DB와 업무 기능의 readiness를 보장하지
않습니다. PG bearer를 받기 전에 ERP SQLite migration v5(`auth_identity`)를 적용해야
하며, 기존 숫자 ID membership은 소유권 확인 없이 자동 연결하지 않습니다. 전체 기동
순서, DB 구분과 readiness 판정은
[`docs/20-operations-manual.md`](docs/20-operations-manual.md)를 따릅니다.

## 검증

```bash
npm test
npm run build
node scripts/check_local_startup.mjs
node scripts/check_structure.mjs
python scripts/check_docs_coverage.py
python scripts/check_deliverables.py
npm audit

cd Reservation/backend
npm test
npm run build
```

`check_local_startup.mjs`는 임시 SQLite 파일과 임의 포트로 ERP를 실제 기동해
migration, liveness, route catalog를 확인하고 자체 정리합니다. 원격 DB, 예약 DB,
실제 배포와 복구는 수행하지 않습니다. 운영 절차와 외부 차단 조건은
[`docs/21-deployment-manual.md`](docs/21-deployment-manual.md) 및 현재 실행 보고서를
참조하십시오.
