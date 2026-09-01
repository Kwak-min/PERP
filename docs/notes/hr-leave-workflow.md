# 인사(HR) · 휴가 모듈 작업 노트

담당: HR 모듈 전체(HR-001~004, 브랜치 `feature/leave-hr/hojin`) — 휴가(HR-003)부터 진행 중
작성일: 2026-08-13
목적: 다른 팀원이 이 파트의 진행 상황과 경계를 빠르게 파악할 수 있도록 정리. 원 스펙(요구사항·화면·API·권한)의 단일 진실원천은 `docs/00-requirements-traceability.md`, `docs/06-screen-routes.md`, `docs/05-permission-matrix.md`이며, 이 문서는 그 스펙을 휴가 파트 관점에서 어떻게 나눠 구현하는지 기록하는 작업 로그다.

## 휴가 업무 전체 프로세스 (6단계)

| 단계 | 내용 | 상태 |
| --- | --- | --- |
| 1 | 인사 담당자 휴가 정책 설정 (종류별 기본 부여일수, 이월·소멸 규칙) | 완료 — `/hr/leave` "관리" 탭. 이월·소멸은 값 저장만 하고 집행 로직은 없음(의도적 범위 제한) |
| 2 | 휴가 부여 (관리자가 구성원별 잔여일수 확정) | 완료 — 정책 기본값이 자동으로 채워지는 부여 폼 |
| 3 | 직원 휴가 신청 | 완료 — `/hr/leave` "내 휴가" 탭 |
| 4 | 관리자 승인/반려 | 완료 — 승인 대기 목록 + 승인/반려 버튼 |
| 5 | 잔여일수·캘린더 등 정보 반영 | 완료 — 승인 시 자동 차감, 캘린더·통계 즉시 반영 |
| 6 | 이력 및 통계 관리 | 완료 — 조직 소진율(산식·기준시각 표시) + 구성원별 소진율 표 + 상태 필터·CSV 내보내기 |

## 조사로 확인한 현재 상태 (2026-08-13)

**백엔드** (`backend/src/controllers/hr.controller.js`) — 신청·승인/반려·잔여일수·팀 캘린더 API가 이미 다 구현되어 있음: `requestLeave`, `leaveCalendar`, `listLeaves`, `decideLeave`, `listBalances`, `grantBalance`. 감사로그·알림·잔여일수 검증 포함.

**프론트엔드 갭:**
- 화면정의서(`docs/06-screen-routes.md` HR-003)는 `/hr/leave`를 전용 화면으로 규정하지만, `frontend/src/screens/registry.ts`에 오버라이드가 없어 데모 픽스처로만 렌더링됨.
- 실제 신청/잔여일수/캘린더 기능은 HR-002(`/hr/attendance`, `AttendanceScreen.tsx`)에 섞여 들어가 있어 화면 분리 원칙 위반.
- 승인 UI가 어디에도 없음 (`listLeaves`/`decideLeave`를 호출하는 프론트 코드 없음).
- 신청 폼에 대직자(`substitute_id`) 입력란 없음 (백엔드는 받는데 프론트가 안 채움).
- HR-003이 사이드바 네비게이션에 없음.

**다른 파트 담당자가 알아야 할 이슈 (이번 범위 밖):**
- **전자결재(SFR-020) 담당자**: 휴가 신청이 만드는 전자결재(`approval`)를 일반 결재함(`/approvals`)에서 승인해도 `leave_request` 상태·잔여일수가 갱신되지 않음 (두 경로가 분리돼 있고 동기화 안 됨). `backend/src/controllers/approvals.controller.js`의 `decide()`가 `leave_request` 테이블을 전혀 건드리지 않기 때문. 논의 필요.
- **인사 프로필(HR-001) 담당자**: 단일 구성원 상세 조회 API 자체가 없음, 소속·직책 이력 테이블도 없음.
- **모집(HR-004) 담당자**: `moveStage` 외 상태변경 액션에 감사로그 누락, 지원자 개인정보 보존기간(`retain_until`)이 저장만 되고 자동 파기가 전혀 구현 안 됨 (`docs/09-data-classification.md`상 "채용 종료 후 6개월 자동 파기" 요구사항 미이행).

## 이번 작업 단위 범위

**포함 (3~5단계):**
1. `frontend/src/hooks/useMembers.ts` 신규 — 업무대행 선택/이름 표시용 구성원 목록 훅
2. `LeaveRequestForm.tsx`에 업무대행 선택란 추가
3. `frontend/src/screens/LeaveScreen.tsx` 신규 — 잔여일수 카드 + 팀 캘린더 + 신청 목록(자기 것만 또는 승인 대상) + 승인/반려 버튼
4. `AttendanceScreen.tsx`에서 휴가 관련 섹션 제거 (화면 분리)
5. `registry.ts`/`catalog.ts`에 HR-003 등록 + 사이드바 노출

**제외 (후속 단위로 분리):**
- 1단계(정책 설정), 2단계(부여 UI), 6단계(이력·통계) — 새 테이블/설계 필요
- 결재함 ↔ `leave_request` 동기화 버그 — 전자결재 담당자와 먼저 논의

상세 설계는 세션 로컬 plan 파일(`~/.claude/plans/fizzy-wibbling-cocoa.md`, 이 컴퓨터에만 있음)에 있고, 이 문서는 그 요약+ 팀 공유용 버전이다.

## 진행 로그
- 2026-08-13: 현재 상태 조사 완료, 3~5단계 범위로 착수.
- 2026-08-13: 3~5단계 구현 완료.
  - 신규: `frontend/src/hooks/useMembers.ts`, `frontend/src/screens/LeaveScreen.tsx`
  - 수정: `LeaveRequestForm.tsx`(대직자 선택란), `attendance/model.ts`(`leaveListSchema`), `AttendanceScreen.tsx`(휴가 섹션 제거), `registry.ts`/`catalog.ts`(HR-003 등록 + 사이드바 노출)
  - 백엔드 변경 없음(기존 API 재사용)
  - 검증: `tsc -b` 통과, 프론트 `npm test`(route parity 59/59) 통과, 백엔드 `npm test` 20/20 통과, 헤드리스 브라우저로 회원가입→조직생성(hr 모듈 on)→구성원 초대(API)→휴가 신청(대직자 포함)→승인 UI 클릭까지 실제 흐름 확인(콘솔 에러 0건)
  - 남은 것: 1·2·6단계(정책/부여UI/이력통계), 결재함↔leave_request 동기화 버그 — 위 "이번 범위에 포함하지 않음" 참고
- 2026-08-13: "대직자" 용어를 화면정의서(HR-003)의 공식 표현인 "업무대행"으로 통일 (라벨, 표 헤더, 코드 주석, 픽스처 전체).
- 2026-08-13: 1·2·6단계(정책·부여·통계) 구현 완료.
  - **배치**: 새 화면을 만들지 않고 `/hr/leave` 안에 "내 휴가"/"관리" 탭 추가. "관리" 탭은 `leave.approve` 권한이 있을 때만 노출(서버 403 여부로 판단 — 프론트가 역할을 직접 판단하지 않음).
  - **정책 범위**: 종류별 기본 부여일수 + 이월 허용/한도 + 소멸 메모까지 저장. 이월·소멸의 실제 집행(스케줄러)은 의도적으로 범위 밖(코드베이스에 cron 인프라가 아예 없음).
  - **권한**: 새 권한 없이 기존 `leave.approve` 재사용 (`rbac.js` 변경 없음).
  - 백엔드 신규: `backend/src/config/schema.js`에 `leave_policy` 테이블, `hr.controller.js`에 `listLeavePolicies`/`upsertLeavePolicy`/`leaveStats`, `hr.routes.js`에 라우트 3개. 기존 `grantBalance`에 누락돼 있던 감사로그(`audit.record`)도 추가.
  - 프론트 신규: `hooks/useLeavePolicies.ts`, `screens/leave/`(`LeavePolicyPanel.tsx`, `LeaveGrantPanel.tsx`, `LeaveStatsPanel.tsx`, `leave.css`), `LeaveScreen.tsx`에 탭 배선.
  - `leaveStats` 응답에 `formula`(산식 문자열) + `generated_at`(타임스탬프)을 함께 반환 — 기존에 `finance.controller.js`(산식)와 `analytics.controller.js`(타임스탬프)가 따로 쓰던 두 관례를 처음으로 한 응답에 합침 (SFR-028 "산식·기준시점·갱신시각 표시" 요건).
  - 검증: 백엔드 테스트 2건 추가(`backend/tests/leave-management.test.js`, 정책 upsert+403, 소진율 계산 정합성) 포함 전체 22/22 통과. 프론트 `tsc -b` 클린, `npm test` 59/59. 헤드리스 브라우저로 정책 설정→부여(기본값 자동 채움 확인)→신청→승인→통계 반영, 그리고 일반 member 계정엔 "관리" 탭이 안 보이는 것까지 전체 흐름 확인.
  - 버그 하나 잡음: 체크박스 입력에 전역 `input { width:100% }` 규칙이 적용돼 "이월 허용" 체크박스가 171px로 늘어나는 문제 — 코드베이스에 이미 있던 `.check-label input` 패턴처럼 `.policy-row__checkbox input`에 고정 크기를 줘서 해결.
