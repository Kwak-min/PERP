# 02. 기술 스택 확정안

사용자 결정에 따라 OrbitFlow의 구현 스택은 **Node.js/Express + Vite**로
고정한다. 과업지시서의 초기 FastAPI/Next.js 제안보다 이 결정이 우선하며,
해당 구현 트리는 동등 기능 이식 후 제거했다.

## 확정 버전

| 계층 | 기술 | 현재 버전·원칙 |
|---|---|---|
| Workspace | npm workspaces | 루트에서 backend/frontend 설치·검증 |
| Backend runtime | Node.js | 24.18.0 검증, 최소 22.5 |
| HTTP API | Express | 5.2.1, `/api/v1`, route catalog 제공 |
| Validation | Zod | API 경계 schema parsing |
| Database | SQLite | Node 내장 `node:sqlite`, WAL, foreign keys, transaction |
| Frontend build | Vite | 8.2.1 production build |
| UI runtime | React | 19.1.1 |
| Routing | React Router | 7.18.2, 56 unique route paths |
| Type safety | TypeScript | 5.9.2 strict, noUncheckedIndexedAccess, exact optional |
| AI Gateway | Provider adapters | echo / Ollama / OpenRouter |
| Browser QA | Playwright | 1.62.1 + installed stable Chrome |

`npm audit` 결과는 2026-08-10 기준 취약점 0건이다.

## Backend

- `src/app.js`는 JSON/CORS/request context/error middleware와 route groups를
  조립하고 `src/server.js`는 schema migration 후 listener를 시작한다.
- 세션 원문은 저장하지 않고 fingerprint만 저장한다. 로그인 실패 제한,
  전체 세션 회수, 임시 비밀번호 강제 변경을 지원한다.
- 공통 scoped query가 tenant/org 조건과 soft delete를 적용한다.
- RBAC 11역할, 모듈 19종(필수 6/선택 13), 사용 중 enable/disable을 지원한다.
- 감사로그는 append-only 이전 hash/current hash 체인과 검증 API를 제공한다.
- 회계, 자산/예약, HR, 문서/회의, 자동화/연동/분석/import를 같은 API와
  트랜잭션 경계에서 운영한다.

## Frontend

- Vite SPA와 React Router를 사용하며 public auth flow와 51 authenticated
  screen paths를 합쳐 56 unique paths를 제공한다.
- `services/api.ts`가 토큰, 조직 header, 오류 parsing을 소유한다.
- session store는 localStorage를 parse한 뒤 `useSyncExternalStore`로 구독한다.
- 248px desktop sidebar, 64px topbar, optional 420px Agent panel과 375px mobile
  bottom navigation을 제공한다.
- loading, empty, error, permission-denied 상태를 공통 boundary로 표시한다.
- 디자인 token은 indigo product identity와 violet AI surface를 분리한다.

## AI와 데이터 등급

- `internal` 데이터는 설정된 OpenRouter 등 외부 provider로 라우팅할 수 있다.
- `sensitive`와 `confidential` 데이터는 외부 provider로 전송하지 않는다.
- RAG는 principal scope 안의 document chunks만 사용한다.
- 비밀번호, API key, 주민등록번호 패턴은 Agent memory에 저장하지 않는다.
- 고위험 action은 preview -> approval -> re-authentication -> execution ->
  rollback 순서를 강제한다.
- 실제 provider secret은 `backend/.env`에만 두며 `.env.example`에는 빈 값만
  제공한다.

## 비협상 규칙

- 금액에 floating point를 사용하지 않는다.
- 모든 조직 쿼리에 `tenant_id`와 `org_id`를 적용한다.
- 마감 회계기간 변경은 409이며 승인된 재오픈 뒤에만 허용한다.
- optimistic version, idempotency, request ID와 audit trail을 유지한다.
- 비밀키, SQLite runtime DB, build output, QA artifacts는 커밋하지 않는다.
- 변경 완료 판단은 타입 검사, 20개 backend test, route parity, production
  Vite build, real-Chrome E2E와 teardown 영수증으로 한다.
