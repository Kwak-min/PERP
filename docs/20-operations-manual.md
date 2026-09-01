# 운영 매뉴얼 (Operations Manual)

## 1. 시스템 구성

| 구성요소 | 역할 | 기본 포트 |
|---|---|---|
| `orbitflow-backend` | Express REST API, AI Gateway, audit chain | 8000 |
| `orbitflow-frontend` | Vite/React SPA, 56 route paths | 5173(dev) |
| SQLite | tenant-scoped operational data, WAL/foreign keys | file |
| Ollama (선택) | sensitive/confidential local AI provider | 11434 |

외부 AI를 사용할 때만 OpenRouter를 활성화한다. secret은 런타임
`backend/.env` 또는 운영 Secret Manager로 주입한다.

## 2. 기동과 상태 점검

### 기동

```bash
npm ci
npm run dev:backend
npm run dev
```

운영은 `npm run build` 결과인 `frontend/dist`를 정적 호스팅하고
`npm run start`로 Express를 시작한다. SPA의 `/api`는 reverse proxy로
Express에 전달한다.

### 상태 점검

| 점검 | 정상 기준 |
|---|---|
| `GET /health` | HTTP 200, `status=ok` |
| `GET /api/v1/routes` | 18 route groups |
| `GET /api/v1/integrations/audit/verify` | `valid=true` |
| `GET /api/v1/agent/providers` | 허용 provider 상태 표시 |
| `GET /api/v1/agent/usage` | latency/token/cost/result 기록 |

정기적으로 `npm test`, `npm audit`, 원장/보고서 합계와 audit chain을
검증한다.

## 3. 백업·복구

1. 변경 요청 유입을 차단하고 Express를 정상 종료한다.
2. SQLite DB와 환경별 업로드 디렉터리를 암호화된 백업 저장소에 복사한다.
3. Secret Manager는 별도 보존 정책으로 백업하며 DB 백업에 포함하지 않는다.
4. 복구 환경에 DB를 배치하고 Express를 시작해 schema migration을 적용한다.
5. `npm test`와 production E2E를 실행하고 audit/finance 합계를 확인한다.

목표 RPO는 24시간, RTO는 4시간이며 운영 규모에 따라 snapshot 주기를
단축한다.

## 4. 장애 대응

| 증상 | 확인 | 조치 |
|---|---|---|
| 5xx 급증 | `X-Request-Id`, Express stderr | 최근 배포 롤백, DB 권한/디스크 확인 |
| DB busy | WAL/SHM, 장기 실행 프로세스 | 정상 종료 후 lock owner 확인, 임의 파일 삭제 금지 |
| AI 실패 | `/agent/providers`, usage result | echo/Ollama fallback, OpenRouter key/quota 확인 |
| 회계 불일치 | transaction/ledger/report | 마감/재오픈 audit 확인, 직접 DB 수정 금지 |
| audit invalid | verify API broken sequence | 보안 incident로 분류하고 원본 보존 |

## 5. 모니터링

- API 조회 P95 1.5초, 변경 P95 2초
- AI 첫 응답 P95 5초, 전체 응답 P95 30초
- HTTP 5xx, login lockout, approval rejection, rollback 실패율
- SQLite 파일/디스크 사용량과 backup age
- OpenRouter token/cost 및 민감 등급 외부 전송 차단 건수
