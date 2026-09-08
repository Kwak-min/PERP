# Task24 분석 API / Task25 소비 계약

## 경로 및 DTO

모든 경로는 `/api/v1` 아래이며 Bearer 인증과 `X-Org-Id`가 필요하다. legacy는 실제 organization ID, PG는 `pg:<company_id>`를 선택한다. PG 분석은 실제 PG 소속/역할만 사용하며 SQLite membership을 만들거나 합성하지 않는다. 화면25 변경은 이 작업에 포함하지 않는다.

- `GET /analytics/kpis`, `GET /pg/analytics/kpis`
- 필터 예: `?from=2026-09-01&to=2026-10-01&tz=Asia/Seoul`
- 응답: `{scope:{source:"legacy"|"perp_db",org_id},period:{from,to,tz},generated_at,metrics,series:[]}`
- metric: `{key,state,value,unit,basis,formula,scope:{source,org_id,rows,tenant_id?},reason?,not_applicable?}`
- 기계 소비 타입: `analytics.contract.d.ts`. key와 unit/basis를 사용한다. formula는 표시용 설명이며 파싱하거나 테스트로 문구를 고정하지 않는다.
- 모든 성공 응답 및 CSV는 `Cache-Control: private, no-store`다.

from/to는 연도0000 제외 실제 `YYYY-MM-DD`, 두 값 모두 생략하거나 함께 지정한다. 생략하면 **선택 tz의 이번 달 첫날 -> 다음 달 첫날**이다. tz 기본값은 Asia/Seoul이며 Intl이 인식하는 시간대를 검증한다. from < to, [from,to)다. 잘못된 날짜/배열/중복 파라미터/알 수 없는 필터는400이다. timestamp용 두 경계는 각각 현지 자정의 UTC instant로 변환하므로 DST 일자는24시간으로 가정하지 않는다. 중복 자정은 첫 자정, 존재하지 않는 날짜/자정은400으로 명시 거부한다(예: Pacific/Apia 2011-12-30). 날짜 범위를 몰래 잘라내지 않는다.

## 상태와 표시

| state | value / 의미 |
| --- | --- |
| ready | 원천 행이 있으며 인가된 결과. 금액/비율은 문자열, count는 정수. 합계0일 수도 있다. |
| empty | 성공한 조회의 해당 모집단이0행. count=0, 금액="0.00". 실패나 거부가 아니다. |
| forbidden | 원천 행동 또는 원천 메뉴 권한 없음. value=null, 해당 원천 데이터 SQL을 실행하지 않는다. |
| disabled | 인가된 원천의 module/feature 꺼짐. value=null, 해당 원천 데이터 SQL을 실행하지 않는다. |
| unavailable | 원천 미지원/실패/단위 불일치. value=null, reason은 아래 코드. |

reason: SOURCE_UNSUPPORTED, SOURCE_QUERY_FAILED, MIXED_CURRENCY, CURRENCY_MISMATCH. 원천 SQL 실패는 서버에 기록하고 그 원천 지표만 unavailable로 반환한다. 공통 인증/분석 인가 자체 실패는 HTTP401/403/503이지 성공 DTO가 아니다. 원천 권한 검사가 기능/미지원 판정보다 먼저다.

분모0인 실행률은 `value:null,not_applicable:true`다. 예산0행이면 state=empty, 실제0원 활성 예산이 있으면 state=ready다. null을0%로 표시하지 않는다. 실제 비율은 퍼센트 단위 소수4자리까지0 방향 절삭이며 돈 자체는 반올림/절삭하지 않는다.

## 원천 권한과 행 범위

공통 `analytics.read + menu.analytics + analytics module`을 먼저 검사한다. 각 요청의 controller에서 principal을 다시 조회한다. 내보내기 생성 시 허용되었다는 사실은 다운로드 권한이 아니다. source 메뉴는 단순 사이드바 표시를 넘어 source read 경계다.

| 원천 | 추가 조건 | 행 범위 |
| --- | --- | --- |
| members | member.read + menu.members | PG 실제 활성 company_memberships + active/approved auth.users. legacy tenant/org/deleted 범위의 active membership + active app_user. |
| tasks | task.read + menu.projects + tasks module | PG project.projects.company_id 조인. legacy tenant/org/deleted 및 아래 role scope. |
| finance | transaction.read + menu.finance + finance module | PG e.company_id, 실제 posted entries/동일 회사 accounts. legacy confirmed tenant/org/deleted + role scope. |
| budgets | budget.read + menu.finance + finance module | 현재 PG active / legacy approved 예산 및 role scope. |
| execution | budget.read **그리고** transaction.read + menu.finance + finance module | 인가된 현재 활성 예산과 인가된 기간 장부의 budget_id 연결 교집합. |
| approvals | menu.approvals + approvals feature + approval.request 또는 approval.decide | canonical read predicate. PG pool과 legacy 실제 배정자 경계는 서로 다르다. |
| AI | agent.chat + menu.agent + agent module | legacy tenant + **현재 사용자만**. PG 미지원. |
| audit | audit.read | legacy all role scope에서 기존 tenant-wide audit 원천. org별 사건 수가 아니며 scope.rows=tenant_all, tenant_id 표시. 제한 role scope와 PG는 미지원. |

legacy 일반 원천의 scope=all은 해당 회사다. self: 회원은 자기 소속, task는 자기 assignee, 예산/거래는 자기 created_by. department: 회원은 현재 자기 부서, task는 그 부서의 현재 활성 assignee membership, 예산/거래는 department_id. project: task/예산/거래는 실제 살아 있는 자기 project_member와 같은 회사 project 조인; 회원은 보수적으로 자기 소속만. 조직 밖 project/member 연결은 포함하지 않는다. role scope는 실제 principal의 유효 union이다. PG 현재 역할 체계의 scope는 회사 all이며 가짜 department/self grant를 만들지 않는다.

결재 SQL은 허용된 행을 먼저 제한하고, 결과에도 기존 `canReadApproval` / `canReadPgApproval`을 적용한다. requester-only는 자기 요청만. PG decider는 회사의 **non-draft** pool, approval.request도 있으면 자기 draft를 추가로 볼 수 있다. decider-only로 전환된 사용자는 자기 draft도 볼 수 없다. legacy는 자기 행에 approval.request가 필요하고, 다른 사람의 non-draft는 실제 approval_step 배정 + approval.decide가 필요하다. 미배정 회사 관리자도 다른 사람의 행을 볼 수 없다. PG 회사 pool을 legacy의 배정된 나의 결재로 표시하지 않는다.

## 지표와 정확한 공식

| key | basis | 공식 / 단위 |
| --- | --- | --- |
| members.active | current_snapshot | 위 현재 활성 소속 건수, count. PG auth.users.company_id나 외부 브리지 값이 아니라 실제 소속 테이블 기준. |
| tasks.created | period_flow | 인가된 현재 남아 있는 task의 created_at instant가 기간 안인 수, count. 삭제 전 전체 생성 이력이 아니다. |
| tasks.open | current_snapshot | 현재 status IN (todo,in_progress,blocked), count. 완료/done/취소/review는 제외. |
| tasks.overdue | current_snapshot | 위 open 중 due가 지난 수. PG due_on DATE는 선택 tz의 오늘보다 이전. legacy due_at의10자 DATE도 같은 기준, 그 외 timestamp는 generated_at instant보다 이전. |
| finance.revenue | period_flow | PG posted entry_date DATE 기간의 수익 계정 SUM(credit-debit). legacy confirmed occurred_on DATE 기간의 income amount_minor/100. |
| finance.expense | period_flow | 같은 PG 비용 계정 SUM(debit-credit). legacy confirmed expense amount_minor/100. |
| finance.net | period_flow | 동일 기간/권한/단위의 revenue-expense. |
| finance.journals | period_flow | 기간의 distinct posted journal entry / confirmed transaction ID 수. journal line 수가 아니다. |
| budgets.active | current_snapshot | 현재 활성 예산 건수. 선택 기간과 무관. |
| budgets.amount | current_snapshot | 실제 현재 활성 편성액 합. PG amount, legacy amount_minor/100. |
| budgets.executed | period_flow_current_budget | 현재 활성 예산에 실제 budget_id로 연결된 기간 posted/confirmed 비용 합. 닫힌 예산/미연결 거래/미게시 거래는 제외. |
| budgets.execution_rate | period_flow_current_budget | 위 실행액 / 위 현재 활성 편성액 *100. denominator0은 null/not_applicable. |
| approvals.created | period_flow | read-authorized 요청 created_at 기간 건수. 자기 draft를 포함할 수 있으며 submitted 수가 아니다. |
| approvals.decided | period_flow | 현재 approved/rejected 요청 중 실제 최종 결정 instant가 기간 안인 distinct 요청 수. PG decided_at; legacy approved/rejected steps의 마지막 결정 **instant**. hold/pending/withdraw 제외. |
| ai.calls | period_flow | legacy 인가된 자기 ai_request_log created_at 기간 건수. 다른 사용자 usage가 아니다. |
| audit.events | period_flow | legacy 인가된 tenant-wide audit_event created_at 기간 건수. 회사 카드로 오표시하지 않는다. |

PG monetary unit은 **ledger_decimal**이다. 기존 accounting schema에 통화 열이 없으므로 과거 nullable expense metadata로 KRW를 추정하지 않는다. UI는 '원'을 강제하지 말고 장부 단위로 표시한다. legacy는 실제 transaction_record.currency를 보존하며 amount_minor를100으로 나눈다(기존 source 계약). 여러 통화가 섞인 기간의 monetary KPI는 unavailable/MIXED_CURRENCY, distinct journals는 계속 제공한다. 단일 다른 통화는 그 실제 unit으로 반환한다. legacy 예산 단위는 organization.currency; 연결 실행 거래의 unit이 다르면 실행액/률만 unavailable/CURRENCY_MISMATCH다. 환율 변환은 없다.

PG SQL NUMERIC SUM 결과를 text로 받고 BigInt minor 연산을 한다. legacy는 각 SQLite INTEGER를 CAST(... AS TEXT)로 읽어 BigInt 합산한다. SQLite SUM overflow, Number.MAX_SAFE_INTEGER, PG 한 전표 NUMERIC(18,2) 상한을 넘는 합계도 돈을 Number로 바꾸지 않는다. metadata/payload/receipt/replay amount, budget.spent cache를 금액 원천으로 사용하지 않는다.

legacy 최종 결정 timestamp가 없는 과거 행은 결정 기간에 귀속시키지 않는다. 서로 다른 offset 문자열은 문자열 MAX가 아니라 julianday instant 순서로 선택한다. 단계 이벤트별 건수/처리자 개인 생산성/결정 당시 모든 status 이력을 복원하는 API가 아니다.

current_snapshot은 지금 조회한 상태다. 과거 필터를 선택해도 과거 말일 상태라고 표시하지 않는다. execution은 의도적으로 '선택 기간 흐름 / 현재 활성 예산'의 혼합 basis다. 예산 period 명칭/FY 문자열로 과거 유효 기간을 추정하지 않는다. generated_at은 이 응답 조회 시작시각이며 여러 source query의 전역 atomic snapshot 시각을 보장하지 않는다. **series=[]**이며 전기간 비교/추세/차트를 합성하지 않는다. Task25는 실제 제공된 값만 표시한다.

## 보고서 및 CSV

양쪽 prefix에 같은 경로/필터/인가 계약을 사용한다.

- `GET /analytics/reports/:reportKey?from=...&to=...&tz=...` -> `{reportKey,scope,period,generated_at,items,row_count}`
- `POST /analytics/exports` `{reportKey,filter?:{from?,to?,tz?}}` ->201 `{id,reportKey,filter,status:"ready",row_count,expires_at,requery_on_download:true,download_url}`
- `GET /analytics/exports` -> 현재 actor/company가 만든 최근100개 요청 metadata. 데이터행 export 한도와 무관하며 파일 목록이 아니다.
- `GET /analytics/exports/:id/download` -> CSV, X-Row-Count. 저장된 검증 필터 + 현재 인가로 **현재 원천 데이터를 다시 조회**한다. 생성시 row_count와 달라질 수 있다.
- 위 경로 앞에 `/pg`를 붙이면 PG다. 반환 download_url은 `/api/v1` 기준 상대 경로다.
- 기존 `{kind,params?}` 입력도 동일 allowlist/filter 검증을 거쳐 canonical reportKey/filter로 변환한다. 임의 params는400이다. old monthly/workload 쿼리나 임의 테이블 export를 우회로로 허용하지 않는다.

allowlist와 실제 열:

| reportKey | 행 모집단 | CSV / JSON columns |
| --- | --- | --- |
| members | 현재 활성 인가 소속 | id,user_id,status |
| tasks | 기간 생성 인가 task | id,title,status,created_at,due |
| transactions | 기간 게시/확정 전표 | id,date,revenue,expense,unit |
| budgets | 현재 활성 인가 예산 | id,amount,unit,status |
| approvals_created | 기간 생성 readable 요청 | id,status,created_at |
| approvals_decided | 기간 결정 readable 최종 요청 | id,status,decided_at |

members/budgets의 필터는 응답/요청에 보존되지만 current_snapshot 정의상 날짜로 현재 소속/편성액을 잘라내지 않는다. transactions는 **한 전표 한 행**이며 데이터에 실제 여러 통화가 있으면 각 unit별 행으로 제공한다. CSV와 KPI의 exact 금액 문자열을 유지한다. 빈 결과도 header는 제공한다. CSV 문자열 수식 prefix를 escape하며 제목/신청 본문/회원 개인정보를 무차별 SELECT *로 내보내지 않는다.

조회는 최대100001개 sentinel행을 읽고 실제100000행까지 전부 반환한다.100001행이면 생성/보고서/다운로드 모두413 EXPORT_LIMIT_EXCEEDED와 limit=100000; 조용한5000행 절단이 없다. reportKey 임의값/알 수 없는 필터/잘못된 기간400, action/menu/module/feature 권한 회수403, 타 actor/company 요청404, 만료409다. 파일 cache나 불변 파일을 생성하지 않으며 source query 오류는 export 성공/빈 파일로 숨기지 않는다.

## 저장 및 검증 범위

legacy는 기존 export_job만 사용하고 SQLite migration 번호를 추가 점유하지 않는다. PG는 additive `db/perp_additions_v17_analytics_exports.sql`을 기존 finance/approval base 뒤에 적용한다. v15는 Wiki 예약, v16은 expense import 사용이므로 analytics는 v17이다. 테스트는 실제PG18에서 두 번 적용했다. table에는 요청자/회사/reportKey/검증 필터/만료만 저장하며 원천 데이터/파일을 복제하지 않는다. 기존 finance/approval DDL과 canonical authorization 함수는 변경하지 않았다.

격리 actual HTTP 검증은 `backend/tests/deadline-analytics.test.js`와 별도 실행 `backend/tests/deadline-analytics-native.integration.mjs`다. SQL 관찰 wrapper는 실제 DB query를 그대로 실행하며 SQL-response mock이 아니다. 상세 실행 결과와 처음 실패는 `.omo/evidence/task-24-deadline-erp-redesign/`에 보존한다. 실행한 범위를 전체 배포/Task25 UI/부하시험 통과로 부르지 않는다.
