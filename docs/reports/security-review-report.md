# 보안 검토 결과서

대상: OrbitFlow Node.js/Express 5 API + Vite 8/React SPA  
검토일: 2026-08-10

## 인증

- session 원문 대신 fingerprint를 저장하고 만료/회수 시각을 검사한다.
- 로그인 실패 누적과 timed lockout을 적용한다.
- 관리자 provision 계정은 `must_change_password` 전까지 principal route를
  차단한다. 변경 시 모든 기존 session을 회수한다.
- 자동 test가 임시 비밀번호 로그인, 접근 차단, 변경, session 회수와 재로그인을
  실 HTTP로 검증한다.

## 권한

- membership으로 요청한 `X-Org-Id` 소속을 확인한 뒤 tenant/org principal을
  생성한다.
- 일반 member의 `transaction.write`와 `role.assign`은 403이다.
- 선택 module은 route group 진입 전에 `MODULE_DISABLED` 403을 반환한다.
- 교차 조직 direct resource는 404, spoofed organization header는 403,
  목록은 빈 배열이다.
- 개인 Vault는 같은 조직 member에게도 direct/list 모두 404/empty다.

## AI 안전성

- provider adapter는 echo/Ollama/OpenRouter를 분리한다.
- sensitive/confidential data class는 외부 provider로 라우팅하지 않는다.
- RAG는 principal 범위의 document chunk만 사용한다.
- memory는 비밀번호/API key/주민등록번호 pattern을 거부한다.
- tool allowlist, preview, approval, re-authentication, idempotency와 rollback
  metadata를 강제한다.
- 실제 OpenRouter key는 gitignore된 `backend/.env`에만 존재하고 추적 파일의
  `sk-or-v1` 검색 결과는 0건이다.

## 취약점

| 항목 | 결과 |
|---|---|
| `npm audit` | 0 vulnerabilities |
| Express | 5.2.1 |
| Vite | 8.2.1 |
| React Router | 7.18.2 |
| Playwright | 1.62.1 |
| tenant/RBAC test | 4/4 pass |
| 전체 backend test | 20/20 pass |
| browser console/page error | deliberate error/403 외 unclassified 0 |

초기 고정 버전 audit에서 발견된 Express/Vite/React Router/Playwright advisory는
직접 dependency를 현재 patched release로 올린 뒤 전체 test/build/E2E를
재실행해 해소했다.

## 조치

- 완료: dependency upgrade와 lockfile 갱신
- 완료: `.env`, SQLite, dist, QA artifact gitignore
- 완료: real-Chrome E2E와 PID/listener teardown receipt
- 운영 전: TLS/reverse proxy, Secret Manager, encrypted backup volume 구성
- 정기: `npm audit`, 권한 matrix, audit chain과 restore rehearsal 수행
