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

## 주요 기능과 계약 문서

| 영역 | 동작 | 계약 / 설명 |
|---|---|---|
| 회사 역할·위임 | 역할 정의·배정은 `expected_version`/`expected_roles_version` CAS, 마지막 전체 관리자 보호, 근태·휴가 off 시 자료·권한 보존 | `docs/22-admin-manual.md`, `docs/20-operations-manual.md` §6 |
| 실지출·원증빙 | KRW 실지출을 기존 장부에 기록, JPEG/PNG/PDF 원증빙은 소비 뒤 불변, 인증 blob 다운로드만 | `backend/src/services/expenses.contract.md`, `receipt-files.contract.md` |
| CSV 가져오기 | 업로드 → 불변 preview → 사용자 확정 → `{}` + `Idempotency-Key` 원자 commit, 원본 24시간 만료 | `backend/src/services/expense-import.contract.md` |
| 결재 | draft/pending/approved/rejected/withdrawn, 반려 사유 필수, 종결 원본 불변과 재상신 link | `db/perp_additions_v13/v14`, `docs/22-admin-manual.md` |
| 분석 | `GET /analytics/kpis`, 상태 ready/empty/forbidden/disabled/unavailable 구분, export는 다운로드 시 재조회 | `backend/src/services/analytics.contract.md` |
| LLM Wiki·지식 그래프 | 원본 revision → 검토 전 조사 → 초안 → 사용자가 확인한 digest만 게시, 원본 회수 시 `SOURCE_REVOKED`, strict local 모델만 | `docs/knowledge-wiki-jobs-contract.md`, `docs/knowledge-wiki-publication-interface.md`, `docs/knowledge-wiki-integration-task28.md` |

최종 통합 산출물에는 위 Wiki 계약 문서와 `frontend/THIRD_PARTY_NOTICES.md`가 포함되어야
합니다. 유효한 인용은 추적 가능성이지 사실성 보증이 아니며, 모델이 없을 때 Wiki 작업은
`unavailable`로 표시되고 원본 등록과 게시된 위키 읽기는 계속 동작합니다.

## 기술 스택

- Backend: Node.js (전체 workspace는 22.12+), Express 5, SQLite (`node:sqlite`), PostgreSQL, Zod
- Frontend: Vite 8, React 19, React Router 7, TypeScript strict, Zod
- Reservation: Express 4, TypeScript, Prisma, PostgreSQL
- AI Gateway: OpenRouter, Ollama, deterministic echo adapter (LLM Wiki는 예외: `WIKI_LOCAL_MODEL_CONFIG`의 loopback 로컬 모델만, Echo/외부 fallback 없음)
- 지식 그래프: `3d-force-graph@1.80.0` + `three@0.185.1` (MIT, `frontend/THIRD_PARTY_NOTICES.md`); WebGL 불가 시 키보드 semantic 목록 유지
- 원증빙·CSV: `sharp@0.35.4`(Windows native binary는 Apache-2.0 AND LGPL-3.0-or-later 고지 보존), `file-type@21.3.2`, `pdf-lib@1.17.1`, `csv-parse@7.0.2`; 예약 서비스는 `js-yaml@4.3.2`
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
- ERP route catalog: `GET http://127.0.0.1:8000/api/v1/routes` (현재 21개 그룹)
- `perp_db` connectivity: `GET http://127.0.0.1:8000/api/v1/pg/health`
- Reservation liveness: `GET http://127.0.0.1:8080/health`

`/health` 성공은 프로세스 liveness이며 모든 DB와 업무 기능의 readiness를 보장하지
않습니다. PG bearer를 받기 전에 ERP SQLite migration v5(`auth_identity`)를 적용해야
하며, 기존 숫자 ID membership은 소유권 확인 없이 자동 연결하지 않습니다. 전체 기동
순서, DB 구분과 readiness 판정은
[`docs/20-operations-manual.md`](docs/20-operations-manual.md)를 따릅니다.

SQLite additive migration은 기동 시 자동 적용되며 이번 기능군은 9(역할) → 10(원증빙·실지출)
→ 11(결재) → 12(Wiki) → 13(CSV 가져오기) → 14(Wiki 무효화)입니다. `perp_db`는 DBA가
`db/perp_additions_v11` → v12(두 파일) → v13(enum, 독립 commit) → v14 → v15 → v16 → v17 →
v18 순서로 수동 적용합니다. 원증빙 원본은 `ORBITFLOW_UPLOAD_DIR`에 저장되므로 영속 volume이
필요하고, CSV 원본과 원증빙 임시 업로드의 24시간 정리는 각각 `ORBITFLOW_IMPORT_CLEANUP_STORES`와
`ORBITFLOW_RECEIPT_CLEANUP_STORES`로 켜는 내장 timer입니다(둘 다 기본 꺼짐, stdout 이벤트 수집과
알림은 운영자 몫)
([`docs/21-deployment-manual.md`](docs/21-deployment-manual.md)).

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
실제 배포와 복구는 수행하지 않습니다. 기능별 격리 테스트는
`node scripts/run_deadline_isolated.mjs <명령> <인자>`로 감싸서 실행하며, runner가
`DATABASE_URL`/`PG_*`/provider key를 비우고 임시 DB·포트만 사용하므로 실제 사용자
서비스와 private `.env`에 닿지 않습니다. 운영 절차와 외부 차단 조건은
[`docs/21-deployment-manual.md`](docs/21-deployment-manual.md) 및 현재 실행 보고서를
참조하십시오.
