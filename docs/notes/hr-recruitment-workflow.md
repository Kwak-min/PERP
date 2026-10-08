# 인사(HR) · 모집·온보딩(HR-004) 작업 노트

담당: HR 모듈 전체(HR-001~004, 브랜치 `feature/leave-hr/hojin`) — 휴가(HR-003) 완료 후 모집·온보딩(HR-004)으로 진행
작성일: 2026-08-21
목적: 이 파트의 진행 상황과 경계를 다른 팀원이 빠르게 파악할 수 있도록 정리. 원 스펙(요구사항·화면·API·권한)의 단일 진실원천은 `docs/00-requirements-traceability.md`, `docs/06-screen-routes.md`, `docs/05-permission-matrix.md`이며, 이 문서는 그 스펙을 모집·온보딩 파트 관점에서 어떻게 구현하는지 기록하는 작업 로그다. 휴가(HR-003) 진행 로그는 `docs/notes/hr-leave-workflow.md`에 별도로 있다.

## 조사로 확인한 현재 상태 (2026-08-21)

과업지시서(docx)·요구사항정의서(xlsx) 원문을 직접 다시 확인했다. HR-004 화면 정의(원문): 대상 인사/운영진, 화면구조 "모집 파이프라인+지원자 상세", 컴포넌트 "공고, 지원서, 평가, 합격, 계정초대, 온보딩 체크리스트", 핵심 동작 "지원자 개인정보 보존기간 적용". `docs/06-screen-routes.md`가 이 원문을 그대로 옮겨둔 것도 재확인 — 팀 요약 문서가 원문과 다르지 않다.

**백엔드**(`backend/src/controllers/hr.controller.js`) — 이미 다 구현돼 있었음: `createPosting`/`listPostings`/`closePosting`, `apply`/`listApplications`/`moveStage`(6단계: `applied/screening/interview/offer/hired/rejected` + 평가 점수 0-100), `createOnboarding`/`listOnboarding`/`completeOnboardingItem`. `apply`는 `recruitment.manage` 권한을 요구 — 지원자 공개 접수 폼이 아니라 인사 담당자가 대신 등록하는 내부 도구(스펙상 "대상 사용자: 인사/운영진"과 일치).

**발견한 백엔드 결함 2건(이번에 수정):**
1. `GET /hr/applications`(공고 지정 없이 전체 조회) — `listApplications`가 `req.params.postingId`를 무조건 필터에 넣어서, 이 라우트에서는 `undefined`가 바인딩돼 호출하면 깨졌다(`node:sqlite`가 undefined 바인딩을 던짐). 테스트가 없어서 지금까지 못 잡았음. `postingId`가 있을 때만 필터를 추가하도록 수정.
2. `closePosting`, `completeOnboardingItem`에 감사로그 누락 — `moveStage`는 이미 `audit.record`를 쓰는데 나머지 두 상태변경 액션은 빠져 있었음. HR-003 때 `grantBalance`에 감사로그를 추가했던 것과 같은 패턴의 결함. 둘 다 추가 완료.

**프론트엔드 갭(이번에 채움):** `registry.ts`에 HR-004 오버라이드가 없어 데모 픽스처(가짜 칸반)로만 렌더링되고 있었음. 실제 화면·사이드바 노출 없음.

## 중요 발견 — 지원자 개인정보 자동 파기는 HR-004 담당이 아니다

이전 휴가 노트에 "HR-004 담당자가 자동 파기를 못 만들었다"고 적었던 게 있었는데, 요구사항정의서 원본을 다시 보니 부정확했다. `SFR-030`(데이터 내보내기·삭제, Must)과 `DAR-008`(보존·삭제, Must — "삭제 후 재검색되지 않는다", "보존 정책 실행 결과가 감사 로그에 남는다")은 둘 다 소유 화면이 **`ADM-004`(데이터 보존·내보내기, `/admin/retention`, `/admin/data`)**로 명시돼 있다. HR-004 자신의 요구사항은 `SFR-016`(Should) "필드별 개인정보 공개범위를 준수한다" 수준 — 즉 `application.retain_until` 필드를 저장하고 노출하면 되고, 실제 스케줄러로 지우는 건 ADM-004 담당자 몫이다. 그래서 이번 단위에서 자동 파기를 만들지 않는 게 범위를 줄인 게 아니라 **애초에 HR 담당이 아니다.**

**ADM-004 담당자가 알아야 할 것**: `application` 테이블에 `retain_until`(보존기한) 필드가 있고, 지원자 등록 시 기본값 오늘+6개월로 채워진다. 실제 만료 시 자동 삭제(hard delete) + 감사 기록은 아직 어디에도 구현이 안 돼 있다 — 코드베이스에 cron/스케줄러 인프라가 전무해서(HR-003 이월·소멸 정책도 같은 이유로 저장만 하고 미집행) 새로 만들어야 한다.

## 이번 작업 단위 범위

**포함:**
1. 백엔드 결함 수정 3건(위 참고) — 라우트/스키마/권한 변경 없이 컨트롤러 함수 내부만 수정
2. `frontend/src/screens/recruitment/model.ts` — zod 스키마, 6단계 라벨
3. `PipelinePanel.tsx` — 공고 등록/마감, 지원자 등록(보존기한 기본값 자동 채움), 6단계 칸반(단계 이동·평가 점수·합격 시 계정초대)
4. `OnboardingPanel.tsx` — 구성원별 체크리스트 생성·진행률·완료 처리
5. `RecruitmentScreen.tsx` — 두 패널을 탭("채용 파이프라인"/"온보딩 체크리스트")으로 배치, `registry.ts`/`catalog.ts` 등록 + 사이드바 노출

**설계 결정:**
- **계정초대**: 새 엔드포인트 없이 기존 `POST /members/invites`(`members.controller.js`의 `createInvite`)를 프론트에서 그대로 호출. `application`-`member` 연결 테이블도 새로 만들지 않음 — 스펙이 요구하는 건 "계정초대 액션이 존재한다"이지 지원서-계정 간 영구 링크가 아니라서, 있는 걸 재사용하는 게 가장 단순했다.
- **권한**: 새 권한 추가 없음. `recruitment.manage`(파이프라인 전체)와 `member.write`(계정초대 버튼)를 그대로 재사용 — "인사 담당자" 역할 템플릿이 이미 둘 다 갖고 있어서 실사용에 문제 없음.
- **화면 전체가 단일 권한 레벨**이라 HR-003의 "관리" 탭처럼 별도 권한 프로빙 훅을 만들지 않고, `recruitment.manage`가 없으면 `GET /hr/postings` 호출이 403을 던지는 것을 그대로 에러 배너로 보여주는 것으로 권한거부 상태를 충족시켰다(빈 칸반 + 에러 메시지).
- **자동 파기(스케줄러)**: 이번 단위에서 완전히 제외 — 위에서 확인했듯 ADM-004 담당 영역.

## 진행 로그
- 2026-08-21: 과업지시서·요구사항정의서 원문 재확인, HR-004 현재 상태 조사, 계획 수립.
- 2026-08-21: 구현 완료.
  - 백엔드: `hr.controller.js`의 `listApplications`(postingId 없을 때 필터 생략), `closePosting`/`completeOnboardingItem`(감사로그 추가) 수정. 새 테스트 `backend/tests/recruitment-pipeline.test.js` 3건(전체 지원자 조회, 공고 마감 감사로그, 온보딩 완료 감사로그) 포함 전체 26/26 통과.
  - 프론트: `screens/recruitment/`(`model.ts`, `PipelinePanel.tsx`, `OnboardingPanel.tsx`, `recruitment.css`), `RecruitmentScreen.tsx`, `registry.ts`/`catalog.ts`(HR-004 등록 + 사이드바 노출). `tsc -b` 클린, `npm test`(route parity 59/59) 통과.
  - 검증: 헤드리스 브라우저로 공고 등록 → 지원자 등록(보존기한 기본값 자동 채움 확인) → 4단계 이동(지원접수→서류검토→면접→처우협의→합격) → 합격 단계에서만 "계정초대" 버튼 노출 확인 → 초대 성공 → 온보딩 탭에서 체크리스트 생성(2건) → 1건 완료 처리(진행률 0/2 → 1/2 반영)까지 실제 흐름 확인. `recruitment.manage` 없는 일반 구성원 계정으로는 빈 칸반 + 권한거부 에러 배너가 뜨는 것도 확인.
  - 남은 것: ADM-004(지원자 개인정보 자동 파기 스케줄러) — 위 "중요 발견" 참고, 담당자와 논의 필요. HR-001(구성원 프로필)은 아직 미착수.
