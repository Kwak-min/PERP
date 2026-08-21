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

## 이번 작업 단위 범위

**포함(읽기 위주)**: 프로필 헤더(연락처, 마스킹 재사용) + 소속·직책 이력(감사로그 재구성) + 활동(감사로그 재구성) + 문서(소유자 필터) + 장비(보유자 필터) + ORG-002 목록에서 클릭해 들어가는 연결.

**제외(다음 단위로 분리)**: 역량 CRUD(새 테이블 필요), 본인수정 승인 워크플로우(새 테이블 + 결재 연동 필요). 승인 대상 필드는 이미 정해둠 — **phone·address·birth_date·emergency_contact**(현재 `MASKED_FIELDS`와 동일한 4개, 소속·직책은 기존처럼 인사가 직접 변경하는 것으로 유지).

## 설계 결정

- **`:memberId` = `user_id`**: HR 모듈(휴가·모집)에서 지금까지 "member_id"는 전부 user_id를 의미했다. `members.routes.js`의 기존 관리자용 라우트(`/:membershipId/roles` 등)는 `membership.id`를 쓰는 다른 관례라 헷갈릴 수 있는데, 새 라우트들은 HR 모듈 관례를 따라 user_id로 통일했다.
- **소속·직책 이력 / 활동을 하나의 API로 통합**: 기존 `activity()`(조직 전체 이력 API)에 `member_id` 쿼리 파라미터 하나만 추가해서 재사용. 프론트에서 `action === 'member.assignment.changed'`인 것만 "소속·직책 이력" 탭에, 나머지를 "활동" 탭에 나눠 보여준다. 새 엔드포인트를 따로 안 만들어도 됐다.
- **상세 페이지는 `catalog.ts` 밖에 별도 라우트로**: `App.tsx`에 `<Route path="/hr/members/:memberId">`를 직접 추가(React Router 표준 기능, 새 인프라 아님). `registry.ts`/`catalog.ts`에는 등록하지 않음 — 목록(ORG-002)에서 드릴다운으로만 진입하는 상세 페이지라 사이드바 네비게이션 항목이 필요 없다.

## 진행 로그

- 2026-08-21: 과업지시서 원문 재확인, 현재 상태 조사, 계획 수립(읽기 위주로 범위 축소, 역량/본인수정승인은 다음 단위).
- 2026-08-21: 구현 완료.
  - 백엔드: `members.controller.js`에 `getMemberProfile` 신규, `activity()`에 `member_id` 필터 추가. `documents.controller.js`/`assets.controller.js`에 각각 `owner_id`/`custodian_id` 필터 추가. `rbac.js`의 `hr` 역할에 `asset.read` 추가. `members.routes.js`에 라우트 1개 추가.
  - 프론트: `screens/members/model.ts`, `pages/MemberProfilePage.tsx`(+css), `App.tsx`에 동적 라우트 추가, `MemberListModal.tsx`에 클릭 시 프로필 페이지로 이동하는 기능 추가(+`user_id` 필드 스키마에 추가, 버튼 스타일 CSS 보완).
  - 검증: 백엔드 테스트 4건 추가(`backend/tests/member-profile.test.js`: 마스킹, 404, 활동 필터, 문서/자산 필터) 포함 전체 30/30 통과. 프론트 `tsc -b` 클린, `npm test` 59/59. 헤드리스 브라우저로 ORG-002 목록 클릭 → 프로필 진입 → 5개 탭(프로필/소속이력/활동/문서/장비) 데이터 확인, 소속·직책 이력과 활동이 올바르게 분리되는지, 존재하지 않는 memberId에 대해 404 안내가 뜨는지, 본인 프로필 클릭-스루가 되는지까지 확인.
  - 남은 것: 역량 CRUD, 본인수정 승인 워크플로우(phone/address/birth_date/emergency_contact 대상) — 위 "이번 작업 단위 범위" 참고.
