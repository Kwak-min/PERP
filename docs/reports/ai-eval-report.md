# AI 평가 결과서 (TER-005 / TER-006)

최종 검증일: 2026-08-10  
대상: Express AI Gateway + echo/Ollama/OpenRouter provider adapters

## 종합 판정

| 항목 | 결과 | 판정 |
|---|---|---|
| OpenRouter direct authentication | HTTP 200, `openai/gpt-4o-mini`, reply `OK` | PASS |
| Gateway external routing | provider `openrouter`, model/latency/usage persisted | PASS |
| 권한 인식 RAG 근거 | 회비 문서의 `30,000원`을 정확히 요약 | PASS |
| confidential/sensitive 외부 전송 | provider `echo`로 강제 | PASS |
| 민감 memory 저장 | password/API key/주민번호 3종 모두 400 | PASS |
| 무승인 고위험 실행 | 409 `APPROVAL_REQUIRED` | PASS |
| 승인 + 재인증 실행 | 200, rollback metadata 저장 | PASS |
| rollback | confirmed 거래를 draft로 복원 | PASS |

종합: **PASS**

## 정확도·근거

테스트 조직에 `회비는 매 학기 30000원입니다` 문서를 만든 뒤
`회비 규정 요약`을 Agent Gateway에 요청했다.

- 응답: `회비 규정에 따르면, 회비는 매 학기 30,000원입니다.`
- provider: `openrouter`
- model: `openai/gpt-4o-mini`
- usage: prompt 168 tokens, completion 21 tokens
- result: `ok`

문서 chunk는 인증 principal의 tenant/org 범위에서만 검색된다. 별도 자동
tenant test는 다른 조직의 direct/list 결과가 각각 404/empty임을 검증한다.

## 권한

- `internal`: 설정된 외부 provider 사용 가능
- `sensitive`: 외부 provider 금지, local adapter 사용
- `confidential`: 외부 provider 금지, local adapter 사용
- tool allowlist 밖 `shell.exec`: 403 `PERMISSION_DENIED`
- approver 없는 high-risk preview: 400 `VALIDATION_ERROR`
- 승인 없는 execution: 409 `APPROVAL_REQUIRED`, target 상태 불변

## 승인과 도구 안전성

`backend/tests/agent-onboarding.test.js`가 아래 순서를 real HTTP로 검증한다.

1. draft transaction 생성
2. `confirm.transaction` preview와 approval request 생성
3. 승인 전 execution 409
4. 승인 후 re-authentication 없는 execution 403
5. 승인 + password re-authentication execution 200
6. `restore_field` rollback reference 저장
7. rollback 200과 draft 상태 복원

중복 execution은 409이며 action/audit records는 tenant 범위에 저장된다.

## 재현 절차

```bash
npm test --workspace backend
```

전체 browser 흐름은 `frontend/scripts/e2e.mjs`가 signup부터 approval-gated
Agent execution, rollback과 Vault graph까지 검증한다. 실제 OpenRouter 호출은
runtime `backend/.env`에 key가 있을 때만 수행하며 key 값은 log/report에
기록하지 않는다.
