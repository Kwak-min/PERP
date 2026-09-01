# 테스트 결과서 (Test Result Report)

프로젝트: OrbitFlow  
실행 환경: Windows / Node.js 24.18.0 / npm 11.18.0 / stable Chrome  
최종 실행일: 2026-08-10

## 테스트 범위

| 구분 | 파일·명령 | 검증 |
|---|---|---|
| Backend HTTP | `backend/tests/security.test.js` | tenant/org 격리, Vault 소유자 격리, RBAC, module gating |
| Backend HTTP | `backend/tests/finance.test.js` | draft 제외, 거래=원장=보고서, 마감·승인 재오픈 |
| Backend HTTP | `backend/tests/agent-onboarding.test.js` | AI 승인/re-auth/rollback, 임시 비밀번호 |
| Backend HTTP | `backend/tests/assets-hr.test.js` | 예약 충돌, 근태 중복, 휴가 잔액 |
| Backend HTTP | `backend/tests/remaining-domains.test.js` | automation, webhook, analytics export, HR, atomic import |
| Backend HTTP | `backend/tests/calendar-handover-permissions.test.js` | calendar, handover lifecycle, permission simulation |
| Frontend | `frontend/scripts/check-routes.mjs` | 기존 화면의 56 unique paths parity |
| Production E2E | `frontend/scripts/e2e.mjs` | real Chrome signup부터 Agent/Vault/login/mobile까지 |
| Structure | `scripts/check_structure.mjs` | image-guide directories and no legacy apps tree |

## 실행 결과

| 게이트 | 결과 |
|---|---|
| `npm test` | exit 0 — backend 20/20, route EXPECTED 56/ACTUAL 56/MISSING 0 |
| `npm run build` | exit 0 — Vite 8.2.1, 112 modules, production assets emitted |
| `node frontend/scripts/e2e.mjs` | `E2E GREEN`, browser errors 0, mobile overflow 0 |
| `node scripts/check_structure.mjs` | REQUIRED 35, MISSING 0, FORBIDDEN 0 |
| `npm audit` | vulnerabilities 0 |
| teardown | :8111=0, :4173=0, temporary QA files=0 |

상세 E2E 및 PID teardown 증거는 `docs/reports/n8-e2e-teardown.md`에 있다.

### 대표 실패-우선(RED -> GREEN) 증거

- integrations/analytics/HR route contract: 최초 3건 실패(404/500) 후 parameter
  route를 교정해 5/5 통과.
- 프론트 resource boundary: 새 session object가 매 render 생성되어 spinner가
  반복되던 E2E 실패를 memoization으로 고정 후 전체 E2E 통과.
- structure verifier: `backend/README.md` 누락과 legacy `apps/` 3건을 보고한
  뒤 문서 추가/이식 트리 제거로 MISSING 0, FORBIDDEN 0.

## 미결 사항

N1~N10 acceptance 범위에서 알려진 미결 기능 또는 실패 게이트는 없다.
운영 배포 전에는 실제 운영 Secret Manager, TLS terminator, 백업 목적지와
조직별 외부 provider 비용 한도를 환경에 맞게 설정해야 한다.
