# 03. ERD / 데이터 모델

## 공통 필드 규칙 (모든 업무 테이블 필수)
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID PK | 식별자 |
| tenant_id | UUID FK→tenant | 테넌트 격리 키. 모든 쿼리에 강제 (DAR-001) |
| created_at | timestamptz | 생성 시각 (UTC) |
| created_by | UUID FK→user | 생성자 |
| updated_at | timestamptz | 수정 시각 (UTC) |
| updated_by | UUID FK→user | 수정자 |
| version | integer | optimistic locking |
| deleted_at | timestamptz NULL | soft delete |

인덱스 기본: `(tenant_id, id)`, `(tenant_id, deleted_at)`, 각 목록 화면의 정렬·필터 컬럼 복합 인덱스.
PostgreSQL Row Level Security로 `tenant_id = current_setting('app.tenant_id')`를 강제하고, 애플리케이션 레이어에서도 이중 검증한다.

## 핵심 엔터티 (27)
| 엔터티 | 목적 | 핵심 필드 |
|---|---|---|
| Tenant | 테넌트 격리 단위 | id, name, type, status, plan_id, timezone, currency |
| Organization | 조직 프로필 | tenant_id, name, fiscal_year_start, terminology_profile |
| User | 플랫폼 사용자 | id, email, name, locale, timezone, auth_status |
| Membership | 조직 소속 | user_id, org_id, status, joined_at, left_at |
| Department | 부서/팀 | org_id, parent_id, leader_id, active_period |
| Role/Permission | 권한 정책 | role_id, resource, action, scope, field_mask |
| Project | 프로젝트 | owner, status, dates, budget, visibility |
| Task | 업무 | project, assignee, status, priority, due_at, recurrence |
| Event | 일정·행사 | calendar, times, attendees, resource_reservations |
| Transaction | 수입·지출 | account, amount, date, counterparty, evidence, approval |
| Budget | 예산 | period, org_unit, project, category, version, amount |
| Dues/Invoice | 회비·청구 | payer, rule, amount, due_at, payment_status |
| Asset | 자산·재고 | asset_no, type, quantity, status, location, custodian |
| Reservation | 예약 | resource, requester, start_at, end_at, status |
| Attendance/Leave | 근태·부재 | member, type, period, approval, source |
| Document | 문서 | space, title, content_ref, version, owner, visibility |
| FileObject | 첨부파일 | storage_key, checksum, mime, size, malware_status |
| Meeting/Handover | 회의·인수인계 | participants, source_docs, decisions, checklist, confirmations |
| Approval | 전자결재 | form, requester, steps, current_step, status, due_at |
| Notification | 알림 | recipient, type, channel, read_at, related_resource |
| AgentProfile | 개인 Agent 설정 | user, role_context, preferences, model_policy, tool_scope |
| AgentMemory | 명시적 기억 | owner, content, source, sensitivity, expires_at |
| AIConversation | AI 대화 | user, org, project, messages, citations, cost |
| AgentAction | 도구 실행 | tool, input, preview, approval, result, rollback_ref |
| Workflow | 자동화 정의 | trigger, conditions, actions, version, status |
| Integration | 외부연동 | provider, scopes, token_ref, owner, health |
| AuditEvent | 감사 이벤트 | actor, action, resource, before, after, request_id, created_at |

## 테이블 분해 (구현 매핑)
- `Role/Permission` → `role`, `permission`, `role_permission`, `user_role`(scope: org/department/project/self)
- `Dues/Invoice` → `dues_rule`, `dues_charge`, `dues_payment`
- `Attendance/Leave` → `attendance`, `leave_request`, `leave_balance`
- `Meeting/Handover` → `meeting`, `meeting_agenda`, `meeting_decision`, `handover_package`, `handover_item`, `handover_confirmation`
- `Transaction` → `transaction`, `account`(계정과목), `counterparty`, `transaction_evidence`, `fiscal_period_lock`
- `Task` → `task`, `task_checklist_item`, `task_dependency`, `task_comment`, `task_recurrence`
- `Document` → `space`, `document`, `document_version`, `document_permission`, `document_comment`, `document_chunk`(pgvector)
- `AgentAction` → `agent_action`(tool, input, preview, approval_id, result, rollback_ref)
- `AuditEvent` → append-only + 해시체인(prev_hash, hash) (DAR-007)

## 관계 요약
```
Tenant 1─N Organization 1─N Department (self-parent)
User N─N Organization  via Membership (status, joined_at, left_at, 겸직 다중 허용)
Membership N─N Role via user_role (scope_type, scope_id)
Project 1─N Task 1─N Task(subtask) ; Task N─N Task via task_dependency
Event N─N User via event_attendee ; Event 1─N Reservation ; Event 1─1 Meeting
Budget 1─N Transaction(budget_id) ; Transaction 1─N FileObject(evidence)
Asset 1─N Reservation ; Asset 1─N AssetHistory
Document 1─N DocumentVersion ; Document 1─N DocumentChunk(embedding)
Approval 1─N ApprovalStep ; Approval 1─1 (Transaction|Leave|Settlement|AgentAction)
AgentProfile 1─N AgentMemory ; AIConversation 1─N AgentAction
Workflow 1─N WorkflowVersion 1─N WorkflowRun 1─N WorkflowStepRun
모든 변경 → AuditEvent (actor, action, resource, before, after, request_id)
```

## 회계 정합성 제약
- `fiscal_period_lock`이 걸린 기간의 `transaction` 변경은 재오픈 승인 없이는 거부 (SFR-010).
- 예산 집행률 = 승인 예산 대비 확정 거래 합계. 뷰가 아니라 검증 테스트로 원장 합계와 대조 (완료기준: 합계 일치).
- AI는 `transaction.status = draft`까지만 생성 가능. `confirmed` 전이는 사람 승인 필수.
