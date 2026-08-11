# 04. API 목록

기준: REST `/api/v1`, OpenAPI 자동 생성, JWT/세션 인증, cursor pagination, idempotency key, request_id, 표준 오류코드.

## API 그룹 (18)
| 경로 | 기능 |
|---|---|
| `/api/v1/auth` | login, logout, refresh, oauth, mfa, password-reset |
| `/api/v1/tenants` | create, update, modules, usage, export |
| `/api/v1/members` | invite, list, profile, roles, departments, deactivate |
| `/api/v1/permissions` | roles, policies, simulate |
| `/api/v1/projects` | projects, milestones, risks, members, budgets |
| `/api/v1/tasks` | tasks, comments, dependencies, recurrence, views |
| `/api/v1/calendar` | calendars, events, attendees, availability, sync |
| `/api/v1/finance` | transactions, accounts, budgets, dues, settlements, close |
| `/api/v1/assets` | assets, inventory, loans, maintenance, reservations |
| `/api/v1/hr` | attendance, leave, recruitment, onboarding |
| `/api/v1/documents` | spaces, documents, versions, comments, files, search |
| `/api/v1/handover` | packages, checklist, confirm, archive |
| `/api/v1/approvals` | forms, routes, requests, actions, delegation |
| `/api/v1/agent` | chat, brief, memory, actions, approvals, feedback |
| `/api/v1/automations` | workflows, versions, test, publish, runs, retry |
| `/api/v1/integrations` | connections, oauth, webhooks, api-keys, health |
| `/api/v1/analytics` | reports, definitions, export, schedules |
| `/api/v1/admin` | audit, retention, ai-policy, feature-flags, incidents |

## 공통 규약
- **인증**: `Authorization: Bearer <access>` 또는 httpOnly 세션 쿠키. 조직 컨텍스트는 `X-Org-Id` 헤더 + 서버측 membership 검증.
- **페이지네이션**: `?cursor=&limit=` → `{ "items": [...], "next_cursor": null }`. offset 페이지네이션 금지.
- **멱등성**: 모든 POST/PATCH/DELETE는 `Idempotency-Key` 헤더 허용. 24시간 내 동일 키는 최초 응답 재생.
- **요청 추적**: 모든 응답에 `X-Request-Id`. 오류 본문에도 포함.
- **오류 형식**:
```json
{ "error": { "code": "PERMISSION_DENIED", "message": "...", "details": {}, "request_id": "..." } }
```
- **표준 오류코드**: `VALIDATION_ERROR`(400), `UNAUTHENTICATED`(401), `PERMISSION_DENIED`(403), `NOT_FOUND`(404), `CONFLICT`(409), `VERSION_CONFLICT`(409), `IDEMPOTENCY_CONFLICT`(409), `RATE_LIMITED`(429), `INTERNAL`(500).
- **권한 거부**: 404와 403을 구분하되, 존재 여부 노출이 위험한 리소스는 404로 통일한다.
- **rate limit**: 사용자·테넌트·IP 3중 버킷. AI 엔드포인트는 별도 쿼터·비용 한도.
- **감사로그**: 상태 변경 API는 예외 없이 AuditEvent 기록(before/after/request_id/AI 여부).

## 그룹별 주요 엔드포인트
| 그룹 | 대표 엔드포인트 |
|---|---|
| /auth | POST /login, /logout, /refresh, /password-reset, /mfa/verify, GET /oauth/{provider}/callback |
| /tenants | POST /, PATCH /{id}, GET /{id}/modules, /usage, POST /{id}/export, GET /templates |
| /members | POST /invites, GET /, GET /{id}, PATCH /{id}/roles, /departments, POST /{id}/deactivate |
| /permissions | GET /roles, POST /roles, PATCH /roles/{id}, GET /policies, POST /simulate |
| /projects | CRUD, /{id}/milestones, /risks, /members, /budgets, /activity |
| /tasks | CRUD, /{id}/comments, /dependencies, /recurrence, /checklist, GET /views |
| /calendar | GET /calendars, CRUD /events, POST /events/{id}/attendees, GET /availability, POST /sync |
| /finance | /transactions, /accounts, /budgets, /dues, /settlements, POST /close, POST /close/reopen, GET /ledger, /reports |
| /assets | /assets, /inventory, /loans, /maintenance, /reservations, GET /{id}/history |
| /hr | /attendance, /leave, /recruitment, /applications, /onboarding, /offboarding |
| /documents | /spaces, /documents, /{id}/versions, /comments, /files, GET /search, /meetings |
| /handover | /packages, /{id}/checklist, POST /{id}/confirm, POST /{id}/archive |
| /approvals | /forms, /routes, /requests, POST /requests/{id}/actions, /delegation |
| /agent | POST /chat(SSE), GET /brief, CRUD /memory, /actions, POST /actions/{id}/approve, /feedback, GET /providers |
| /automations | /workflows, /{id}/versions, POST /test, /publish, GET /runs, POST /runs/{id}/retry |
| /integrations | /connections, /oauth/{provider}, /webhooks, /api-keys, GET /health |
| /analytics | /reports, /definitions, POST /export, /schedules |
| /admin | /audit, /retention, /ai-policy, /feature-flags, /incidents, /data |

부가 경로: `/search`(전역검색, PER-003), `/files`(업로드·presigned, SER-003), `/imports`(DAR-003/009), `/exports`(PER-006), `/notifications`(SFR-027), `/data-dictionary`(DAR-002), `/data-policy`(DAR-004), `/webhooks`(SIR-008).
