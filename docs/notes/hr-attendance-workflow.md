# 인사(HR) · 근태(HR-002) 작업 노트

담당: HR 모듈 전체(HR-001~004, 브랜치 `feature/leave-hr/hojin`)
작성일: 2026-08-23
목적: HR-002 진행 상황 기록. 전체 HR 모듈 현황은 [hr-module-overview.md](./hr-module-overview.md) 참고.

## 조사로 확인한 현재 상태

과업지시서에 두 버전이 있다는 걸 이번에 확인했다.

- **공식본**(`전체과업지시서.docx` + `전체요구사항정의서.xlsx`, v2.0/2026.08): HR-002 컴포넌트 = "출석, 근무, 활동시간, 수정요청, 승인" — 구체적인 UI는 명시 안 함.
- **초안본**(`과업지시서/` 폴더, 곽민성 작성 노션 내보내기): SFR-007 "출석 가능 여부" 세부내용 = "출근 버튼 및 시간 저장 / 퇴근 버튼 및 시간 저장" — 공식본보다 구체적.

두 문서가 번호는 다르지만(공식본 SFR-007은 다른 항목 "프로젝트 관리") 내용은 모순되지 않고, 초안본이 공식본의 "출석"을 구체화한 것으로 판단해 그대로 반영했다.

`AttendanceScreen.tsx`는 조사 시점에 조회(통계+월별 기록표)만 되고, 실제로 출근/퇴근을 남기거나 잘못된 기록을 고치는 기능이 전혀 없었다. 백엔드 `POST /hr/attendance`(수동 기록 입력)는 있었지만 체크인/체크아웃 개념(시각 저장)과 수정요청·승인 워크플로우는 백엔드에도 없었다. 조장 MVP 때부터 없던 부분이라 회귀는 아니고, 스펙 대비 실제 누락이었다.

## 설계 결정

- **본인수정 승인은 결재함(`/approvals`)을 거치지 않는다**: HR-001의 연락처 수정요청과 동일한 이유 — 휴가 신청이 결재함에도 레코드를 만드는데 결재함에서 승인해도 `leave_request`가 안 바뀌는 동기화 버그가 있어서, 근태에서 같은 함정을 또 만들지 않으려고 프로필 페이지/근태 화면 자체에서 신청→승인이 완결되게 했다.
- **출근 시 자동으로 지각/결근 판정은 하지 않는다**: 앱 어디에도 "정규 출근 시각" 같은 근무시간 정책 설정이 없어서, 체크인은 항상 `kind: 'present'`로 남기고 늦었는지 여부는 필요하면 수정요청으로 사람이 판단해서 고치는 구조로 뒀다. 새로 근무시간 정책 기능을 만드는 건 이번 범위 밖.
- **"관리" 탭 노출 판단**: HR-001/HR-003과 같은 관용구 — `GET /hr/attendance/corrections/pending`(`attendance.write` 필요) 호출이 성공하는지로 판단, 별도 권한 프로빙 훅 없이 그 자리에서 try/catch.

## 진행 로그

- 2026-08-23: 과업지시서 초안(`과업지시서/` 폴더)에서 SFR-007 "출석 가능 여부"(출근/퇴근 버튼+시간저장) 발견, 공식본과 대조해 HR-002 스펙 확정. 계획 수립.
- 2026-08-23: 구현 완료.
  - 백엔드: `schema.js`에 `attendance.check_in_at`/`check_out_at` 컬럼, `attendance_correction_request` 테이블 신규. `hr.controller.js`에 `checkIn`/`checkOut`/`createAttendanceCorrection`/`listMyAttendanceCorrections`/`listPendingAttendanceCorrections`/`decideAttendanceCorrection` 6개 함수 신규. `hr.routes.js`에 라우트 6개 추가.
  - 프론트: `screens/attendance/model.ts`에 스키마 추가, `screens/attendance/AttendanceCorrectionPanel.tsx` 신규(본인 신청/이력 + 관리 승인 큐를 `mode` prop으로 한 컴포넌트에서 처리), `AttendanceScreen.tsx`에 출근/퇴근 버튼 + "내 근태"/"관리" 탭 추가.
  - 공용 CSS 정리: HR-001에서 쓰던 `.member-profile-list`/`.member-profile-subheading`을 근태 화면에서도 재사용하게 돼서 `.simple-list`/`.simple-list__subheading`으로 이름을 바꿔 전역 `styles.css`로 옮김(페이지 전용 CSS를 다른 화면이 import하는 모양이 되는 걸 피하려고).
  - 검증: 백엔드 테스트 4건 추가(`backend/tests/attendance-checkin.test.js`: 체크인→체크아웃 hours 계산, 체크인 없이 체크아웃 409, 일반 구성원의 대기 큐 조회 403, 승인 시 실제 반영/반려 시 미반영/재처리 409) 포함 전체 38/38 통과. 프론트 `tsc -b` 클린, `npm test` 59/59. 헤드리스 브라우저로 구성원 계정 출근(시각 표시) → 퇴근(시각+근무시간 표시) → 수정요청 제출 → owner 계정 "관리" 탭에서 대기 목록 확인 후 승인 → 큐에서 사라지는 것까지 확인, 일반 구성원 계정엔 "관리" 탭이 안 보이는 것도 확인.
  - 로컬 개발 중 겪은 것: 스키마에 컬럼을 추가해도 로컬 DB 파일이 이미 있으면 `CREATE TABLE IF NOT EXISTS`가 기존 테이블엔 안 먹혀서 새 컬럼이 실제로는 안 생기는 문제 재확인 — DB 파일 삭제 후 서버 재시작으로 해결(이전에도 겪었던 것과 동일한 패턴).
  - 남은 것: 없음(HR-002 완료).
