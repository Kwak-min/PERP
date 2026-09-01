# 08. AI Agent 도구 목록 및 실행 정책

## 실행 5단계 (엄격 분리)
| 단계 | 허용 범위 | 승인 |
|---|---|---|
| 1 조회 | 권한 필터 적용 검색·요약·비교 | 불필요 |
| 2 추천 | 업무·담당자·일정·계정과목·예산 추천 | 불필요 |
| 3 초안 | 문서·공지·보고서·지출·결재 초안 생성 (draft 상태) | 불필요 |
| 4 승인요청 | 담당자/관리자에게 실행 미리보기와 함께 요청 | 요청 생성 |
| 5 실행 | 승인된 범위 내 API 호출로 실제 데이터 변경 | **필수** |

금전 / 권한 변경 / 외부 발송 / 회원 상태 변경 / 회계 확정 / 데이터 삭제 = **무조건 승인 후 실행**, 고위험은 2차 승인 + 재인증.

## 도구 allowlist
| 도구 | 단계 | 리소스 | 권한 요구 | 승인 | 롤백 |
|---|---|---|---|---|---|
| search.documents | 조회 | Document | document.read | - | - |
| search.tasks | 조회 | Task | task.read | - | - |
| search.events | 조회 | Event | event.read | - | - |
| search.transactions | 조회 | Transaction | transaction.read | - | - |
| search.members | 조회 | Membership | member.read | - | - |
| search.meetings | 조회 | Meeting | meeting.read | - | - |
| get.brief | 조회 | 다중 | self | - | - |
| analyze.budget_risk | 조회 | Budget | budget.read | - | - |
| analyze.overdue_tasks | 조회 | Task | task.read | - | - |
| analyze.anomaly_transaction | 조회 | Transaction | transaction.read | - | - |
| recommend.assignee | 추천 | Task | task.read | - | - |
| recommend.account_code | 추천 | Transaction | transaction.read | - | - |
| recommend.budget_line | 추천 | Budget | budget.read | - | - |
| recommend.schedule_slot | 추천 | Event | event.read | - | - |
| draft.document | 초안 | Document | document.write | - | 버전 되돌리기 |
| draft.notice | 초안 | Document | document.write | - | 버전 되돌리기 |
| draft.meeting_minutes | 초안 | Meeting | meeting.write | - | 버전 되돌리기 |
| draft.handover_package | 초안 | Handover | handover.read | - | 패키지 삭제 |
| draft.report | 초안 | Analytics | analytics.read | - | - |
| draft.settlement | 초안 | Transaction(draft) | settlement.create | - | draft 폐기 |
| draft.approval_request | 초안 | Approval | approval.request | - | 회수 |
| extract.receipt_ocr | 초안 | FileObject | settlement.create | - | - |
| create.task | 실행 | Task | task.write | 사용자 확인 | 삭제 |
| update.task_status | 실행 | Task | task.write | 사용자 확인 | 이전 상태 복원 |
| create.event | 실행 | Event | event.write | 사용자 확인 | 삭제 |
| create.document | 실행 | Document | document.write | 사용자 확인 | 삭제 |
| submit.approval | 실행 | Approval | approval.request | 사용자 확인 | 회수 |
| send.notification | 실행 | Notification | 채널 권한 | **승인 필수** | 취소 불가(발송 전 차단) |
| confirm.transaction | 실행 | Transaction | transaction.confirm | **승인+재인증** | 승인된 역분개 |
| update.budget | 실행 | Budget | budget.write | **승인 필수** | 이전 버전 복원 |
| change.member_status | 실행 | Membership | member.write | **승인+재인증** | 이전 상태 복원 |
| change.permission | 실행 | Role | role.assign | **승인+재인증** | 이전 역할 복원 |
| delete.* | 실행 | 전 | 리소스 delete | **승인+재인증** | soft delete 복원 |

allowlist에 없는 도구는 호출 불가. 조직 정책이 개인 설정보다 항상 우선한다.

## 역할별 Agent 프리셋
| Agent | 기본 도구 세트 | 브리핑 항목 |
|---|---|---|
| 회장·대표 | search.*, analyze.*, draft.report | 조직 현황, 지연 업무, 승인 대기, 예산 위험, 행사 준비, 부서별 문제, 이번 주 우선순위 |
| 총무·회계 | search.transactions, analyze.anomaly_transaction, recommend.account_code, extract.receipt_ocr, draft.settlement | 회비 미납, 지출 누락, 미증빙 거래, 예산 초과, 결산 초안 |
| 부서장 | search.tasks, analyze.overdue_tasks, recommend.assignee, create.task | 부서 업무, 부서원 업무량, 지연 업무, 재배정 후보, 행사 준비 |
| 일반 구성원 | search.*(본인 범위), get.brief, create.task(self) | 오늘 일정, 내 업무, 마감 임박, 공지 요약, 준비물 |
| 신임 임원 | search.meetings, search.documents, draft.handover_package | 전임 업무, 반복 일정, 과거 회의·문제, 핵심 문서, 시작 순서 |

## 답변 형식 (고정)
```
결론 / 근거(출처 링크+날짜) / 관련 데이터 / 불확실성 / 추천 다음 행동 / 실행 가능 여부 / 필요한 승인
```
근거 없는 내용을 사실처럼 말하지 않는다. 근거 제시율 95% 이상, 정확도 85% 이상 (TER-005).

## 권한 인식 RAG
1. 질의 → 사용자 principal(tenant, roles, scopes) 확정
2. 벡터 검색 **전에** 메타데이터 필터 적용 (tenant_id, 문서 권한, 민감도 등급, deleted_at IS NULL)
3. 검색 후 재검증 (권한 철회 문서가 인용되지 않음 — DAR-005)
4. 인용에 문서 ID·버전·날짜·링크 부착

## 모델 라우팅
판단 기준: 데이터 민감도 → 작업 종류 → 품질 → 응답속도 → 비용 → 가용성 → 조직 정책 → 로컬 추론 가능 여부.
- 데이터 등급 `민감`/`고기밀`은 외부 LLM 전송 차단 → 로컬(Ollama/llama.cpp)만 허용.
- 장애 시 정책상 허용된 대체 모델로 폴백. 폴백 자체도 기록.
- 모든 요청 기록: `request_id, user_id, tenant_id, model, provider, prompt_token, completion_token, cost, latency, tool_calls, citations, approval, result, error`

## AgentMemory
필드: `owner, content, source, sensitivity, expires_at, usage_scope, created_at, updated_at`
- 사용자는 조회·수정·삭제·전체 초기화 가능. 삭제 즉시 검색·RAG·응답에서 제외.
- 비밀번호·인증키·주민등록번호·계좌 비밀번호 등 고위험 정보는 저장 차단(패턴 + 분류기 이중).

## 프롬프트 인젝션 방어 (SER-004)
- 시스템 정책과 사용자·문서 콘텐츠를 구조적으로 분리하고, 문서 콘텐츠는 `untrusted` 태그로 감싼다.
- 문서 내부 지시문은 명령으로 해석하지 않는다.
- 도구 호출 파라미터는 서버에서 스키마·권한·범위 재검증(모델 출력 신뢰 금지).
- 출력 검증: 비밀값 패턴·권한 밖 리소스 ID 노출 차단.
