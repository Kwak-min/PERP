# 배포 매뉴얼 (Deployment Manual)

## 1. 환경 분리

| 환경 | Database | AI provider | Frontend |
|---|---|---|---|
| dev | isolated SQLite | echo | Vite dev |
| staging | isolated SQLite snapshot | echo/Ollama | production preview |
| production | encrypted persistent SQLite volume | policy-routed | static `dist` |

환경별 DB, secret, OpenRouter quota와 webhook secret을 공유하지 않는다.

## 2. 사전 준비

1. Node.js 24 LTS-compatible runtime과 npm 11을 설치한다.
2. `.env.example`에서 런타임 `.env`를 만들고 Secret Manager 값을 주입한다.
3. `OPENROUTER_API_KEY` 등 secret을 image, log, frontend env에 넣지 않는다.
4. persistent DB/backup volume과 reverse proxy TLS를 준비한다.

## 3. 배포 절차

```bash
npm ci
npm test
npm run build
node scripts/check_structure.mjs
python scripts/check_docs_coverage.py
python scripts/check_deliverables.py
npm audit
```

1. 기존 DB snapshot을 생성한다.
2. 새 Express revision을 별도 포트에서 시작한다. 시작 시 schema가 idempotent하게
   반영된다.
3. `GET /health`와 `GET /api/v1/routes`를 확인한다.
4. `frontend/dist`를 immutable static release로 배포한다.
5. production Chrome E2E를 실행한 뒤 reverse proxy traffic을 전환한다.
6. 구 revision을 정상 종료하고 listener/temporary file teardown을 확인한다.

## 4. 배포 게이트

| 단계 | 필수 게이트 | 실패 시 |
|---|---|---|
| PR | strict TypeScript, backend 20 tests, route parity, secret scan | merge 차단 |
| staging | build, structure/docs, npm audit, real-Chrome E2E | 승격 차단 |
| production | health/routes, tenant/RBAC smoke, audit/finance check | traffic 전환 차단 |

## 5. 롤백

1. traffic을 직전 Express/static revision으로 되돌린다.
2. 호환되지 않는 schema 변경이면 배포 전 SQLite snapshot을 복구한다.
3. audit chain, finance ledger/report, login과 module gating을 재검증한다.
4. 롤백 원인, request ID, DB snapshot과 영향 tenant를 incident 기록에 남긴다.

코드만 롤백하고 새 schema를 그대로 사용할 수 있도록 additive migration을
우선한다. 운영 DB를 수동 편집하거나 실패 test를 삭제해 롤백을 우회하지 않는다.
