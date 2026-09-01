# 인사(HR) · 구성원 프로필(HR-001) 작업 노트

담당: HR 모듈 전체(HR-001~004, 브랜치 `feature/leave-hr/hojin`)
작성일: 2026-08-21
목적: HR-001 진행 상황 기록. 전체 HR 모듈 현황은 [hr-module-overview.md](./hr-module-overview.md) 참고.

## 조사로 확인한 현재 상태 (2026-08-21)

과업지시서 원문 재확인: HR-001 route `/hr/members/[memberId]`, 대상 본인/인사, 화면구조 "프로필 헤더+탭", 컴포넌트 "연락처, 소속·직책 이력, 역량, 문서, 활동, 장비", 핵심 동작 "필드별 공개 범위와 본인 수정 승인".

- 단건 구성원 조회 API가 없었고, "소속·직책 이력"은 전용 테이블 없이 감사로그(`audit_event`)로만 남아있었음.
- "연락처" 필드별 공개범위는 이미 구현돼 있었음: `maskRecord()`/`MASKED_FIELDS`(phone·address·birth_date·emergency_contact) — 본인이면 그대로, 아니면 `member.write` 없을 시 마스킹.
- "문서"/"장비" 탭은 새 저장소가 필요 없었음 — `document.owner_id`, `asset.custodian_id`가 이미 있어서 필터만 추가하면 됨.
- "역량"은 정말 아무 것도 없었음(테이블 자체가 없음).
- `hr` 역할 템플릿에 `asset.read`가 빠져 있어서 인사 담당자가 자산 목록을 못 보는 상태였음(발견해서 수정).
- 라우터가 `catalog.ts` 기반 정적 화면만 지원하고 `:id` 동적 라우트가 지금까지 하나도 없었음 — HR-001이 처음.

## 작업 범위 (2단위로 나눠 진행, 둘 다 완료)

**1단위(읽기 위주)**: 프로필 헤더(연락처, 마스킹 재사용) + 소속·직책 이력(감사로그 재구성) + 활동(감사로그 재구성) + 문서(소유자 필터) + 장비(보유자 필터) + ORG-002 목록에서 클릭해 들어가는 연결.

**2단위(역량 + 본인수정 승인)**: 역량(스킬) CRUD 신규, 본인수정 승인 워크플로우 신규. 대상 필드는 **phone·address·birth_date·emergency_contact**(`MASKED_FIELDS`와 동일한 4개, 소속·직책은 기존처럼 인사가 직접 변경).

## 설계 결정

- **`:memberId` = `user_id`**: HR 모듈(휴가·모집)에서 지금까지 "member_id"는 전부 user_id를 의미했다. `members.routes.js`의 기존 관리자용 라우트(`/:membershipId/roles` 등)는 `membership.id`를 쓰는 다른 관례라 헷갈릴 수 있는데, 새 라우트들은 HR 모듈 관례를 따라 user_id로 통일했다.
- **소속·직책 이력 / 활동을 하나의 API로 통합**: 기존 `activity()`(조직 전체 이력 API)에 `member_id` 쿼리 파라미터 하나만 추가해서 재사용. 프론트에서 `action === 'member.assignment.changed'`인 것만 "소속·직책 이력" 탭에, 나머지를 "활동" 탭에 나눠 보여준다. 새 엔드포인트를 따로 안 만들어도 됐다.
- **상세 페이지는 `catalog.ts` 밖에 별도 라우트로**: `App.tsx`에 `<Route path="/hr/members/:memberId">`를 직접 추가(React Router 표준 기능, 새 인프라 아님). `registry.ts`/`catalog.ts`에는 등록하지 않음 — 목록(ORG-002)에서 드릴다운으로만 진입하는 상세 페이지라 사이드바 네비게이션 항목이 필요 없다.
- **본인수정 승인은 결재함(`/approvals`)을 거치지 않는다**: 휴가 신청이 결재함에도 `approval` 레코드를 만드는 것과 달리, 이 기능은 프로필 페이지 자체에서 신청→승인/반려가 완결된다. 결재함에서 승인해도 `leave_request`가 안 바뀌는 동기화 버그를 여기서 또 만들지 않으려는 의도적 설계(사용자 승인 사항) — `approval.service.js`를 아예 쓰지 않는다.
- **역량은 승인 없이 즉시 반영**: 본인이 직접 입력하는 자기신고 데이터라 승인 절차 없이 바로 추가/삭제된다. 승인이 필요한 건 연락처류 4개 필드뿐.
- **권한 관용구 재사용**: "본인이거나 `member.write`" 체크는 기존 `completeOnboardingItem`의 패턴을 그대로 가져다 씀(`requireSelfOrMemberWrite` 헬퍼로 추출). 승인/반려(`decideFieldRequest`)만 `member.write` 필수, 신청(`createFieldRequest`)은 본인만(HR 대리 신청 없음).

## 진행 로그

- 2026-08-21: 과업지시서 원문 재확인, 현재 상태 조사, 계획 수립(읽기 위주로 범위 축소, 역량/본인수정승인은 다음 단위).
- 2026-08-21: 구현 완료.
  - 백엔드: `members.controller.js`에 `getMemberProfile` 신규, `activity()`에 `member_id` 필터 추가. `documents.controller.js`/`assets.controller.js`에 각각 `owner_id`/`custodian_id` 필터 추가. `rbac.js`의 `hr` 역할에 `asset.read` 추가. `members.routes.js`에 라우트 1개 추가.
  - 프론트: `screens/members/model.ts`, `pages/MemberProfilePage.tsx`(+css), `App.tsx`에 동적 라우트 추가, `MemberListModal.tsx`에 클릭 시 프로필 페이지로 이동하는 기능 추가(+`user_id` 필드 스키마에 추가, 버튼 스타일 CSS 보완).
  - 검증: 백엔드 테스트 4건 추가(`backend/tests/member-profile.test.js`: 마스킹, 404, 활동 필터, 문서/자산 필터) 포함 전체 30/30 통과. 프론트 `tsc -b` 클린, `npm test` 59/59. 헤드리스 브라우저로 ORG-002 목록 클릭 → 프로필 진입 → 5개 탭(프로필/소속이력/활동/문서/장비) 데이터 확인, 소속·직책 이력과 활동이 올바르게 분리되는지, 존재하지 않는 memberId에 대해 404 안내가 뜨는지, 본인 프로필 클릭-스루가 되는지까지 확인.
- 2026-08-23: 2단위(역량 + 본인수정 승인) 구현 완료. HR-001 전체 완료.
  - 백엔드: `schema.js`에 `member_competency`/`member_field_request` 테이블 신규. `members.controller.js`에 `listCompetencies`/`addCompetency`/`deleteCompetency`/`listFieldRequests`/`createFieldRequest`/`decideFieldRequest` 6개 함수 신규(+ 공용 헬퍼 `findMembershipByUserId`/`requireSelfOrMemberWrite` 추출). `members.routes.js`에 라우트 6개 추가.
  - 프론트: `screens/members/model.ts`에 스키마 추가, `screens/members/CompetencyPanel.tsx`/`FieldRequestPanel.tsx` 신규, `MemberProfilePage.tsx`에 "역량" 탭 추가 + "프로필" 탭에 수정신청 패널 통합(본인 신청 폼/이력, HR 승인/반려 큐).
  - 검증: 백엔드 테스트 4건 추가(`backend/tests/member-field-requests.test.js`: 역량 본인/타인 권한, 승인 시 실제 반영, 반려 시 미반영, 이미 처리된 요청 409, 본인만 신청 가능) 포함 전체 34/34 통과. 프론트 `tsc -b` 클린, `npm test` 59/59. 헤드리스 브라우저로 구성원 계정에서 역량 추가 → 전화번호 수정 신청 → owner 계정에서 같은 프로필의 대기 요청 확인 후 승인 → 프로필에 실제 반영 확인, HR이 타인 역량도 삭제 가능한지까지 확인.
  - 남은 것: 없음(HR-001 전체 완료). ADM-004 자동파기, 전자결재 동기화 버그는 여전히 크로스팀 이슈로 남아있음(다른 두 노트 참고).
