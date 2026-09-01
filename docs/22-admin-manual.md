# 관리자 매뉴얼 (Administrator Manual)

대상: 조직 소유자 / 조직 관리자 / 감사자

## 1. 조직 최초 설정
1. **조직 생성**: `/onboarding/organization` — 유형(동아리·학생회·연구실·스터디·비영리·기업) 선택 시 용어·기본 부서·계정과목·모듈이 자동 구성된다.
2. **부서 생성**: `/org-chart` → 부서 추가, 리더 지정.
3. **회원 초대**: `/members` → 초대(이메일+역할). 초대는 14일 후 만료되고 회수·재발송이 가능하다.
4. **역할 배정**: `/settings/roles` — 11개 역할 템플릿(owner/org_admin/chair/dept_lead/treasurer/hr/pm/member/guest/auditor/platform_admin).

## 2. 권한 관리
- 권한 판정은 서버에서 7단계로 수행된다: 인증 → 테넌트·멤버십 → resource/action → scope → 필드 마스킹 → 채널 정책 → 감사기록.
- **권한 시뮬레이션**: `POST /api/v1/permissions/simulate` 로 "이 역할이 이 권한을 갖는가"를 배포 전에 확인한다.
- 개인정보 필드(phone/address/birth_date/emergency_contact)는 본인·인사·관리자 외에는 `***` 로 마스킹된다.
- 화면에서 버튼이 보이지 않는 것은 UX일 뿐이며, API 직접 호출도 동일하게 403 으로 거부된다.

## 3. 회계 통제
| 작업 | 화면 | 통제 |
|---|---|---|
| 거래 등록 | `/finance/transactions` | 등록은 `draft`, 원장 미반영 |
| 거래 확정 | 동일 | `transaction.confirm` 권한자만, 확정분만 원장·집행률 반영 |
| 마감 | `/finance/close` | 마감 기간 거래 생성·수정은 409 `PERIOD_LOCKED` |
| 재오픈 | 동일 | 재오픈 요청 → 승인된 결재가 있어야만 가능 |
| 정산 | `/finance/settlements` | 승인 전 원장 반영 불가(409 `APPROVAL_REQUIRED`) |

## 4. AI 정책 관리 (`/admin/ai-policy`)
- **데이터 등급별 라우팅**: `sensitive`/`confidential` 은 외부 LLM 전송이 차단되고 로컬 모델만 사용한다.
- **도구 allowlist**: 34종. 고위험 도구(`confirm.transaction`, `change.permission`, `change.member_status`, `delete.*`, `send.notification`, `update.budget`)는 승인 필수이며 일부는 재인증까지 요구한다.
- **실행 미리보기**: 모든 변경 도구는 before/after 미리보기 후 승인 → 실행 → `rollback_ref` 저장 순서로만 동작한다.
- **AI 사용량**: `/api/v1/agent/usage` 에서 model/provider/token/cost/latency 를 확인한다.

## 5. 개인 Vault (개인 맞춤형 지식베이스)
- 각 사용자는 `/vault` 에 개인 노트를 두고 `[[위키링크]]` 로 연결한다. 백링크와 그래프(`/vault/graph`)가 자동 생성된다.
- Vault 는 **소유자 전용**이다. 같은 조직의 다른 구성원도 조회·삭제가 404 로 차단된다.
- `agent_enabled` 가 켜진 노트만 개인 Agent 답변의 근거로 사용된다.
- 자격증명 형태의 값(`password:`, `api_key=`, 주민등록번호 패턴)은 저장이 거부된다.

## 6. 감사·보존
- `/admin/audit` — 사용자·AI·시스템 행위의 before/after, request_id, AI 여부가 append-only 해시체인으로 기록된다.
- `GET /admin/audit/verify` — 체인 무결성 검증. `valid=false` 면 즉시 보안 인시던트로 처리한다.
- `/admin/data` — 모듈별 보존기간, legal hold, 조직 전체 내보내기.
- 감사 로그 **검색 권한과 내보내기 권한은 분리**되어 있다(`audit.read` / `audit.export`).

## 7. 데이터 가져오기 (`/api/v1/imports`)
1. `POST /imports/preview` — 오류 행·사유·수정방법을 먼저 확인한다.
2. `POST /imports/commit` (`dry_run=true`) — 저장 없이 검증만.
3. `POST /imports/commit` (`dry_run=false`) — **오류가 1건이라도 있으면 한 건도 저장하지 않는다**(부분 확정 금지). 수정 후 재실행 가능.
