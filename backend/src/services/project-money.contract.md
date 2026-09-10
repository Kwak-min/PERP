# 프로젝트 재무 계약

## 저장소와 적용

- PostgreSQL: 기존 재무 v8/v11/v12 및 writer migration 뒤 `db/perp_additions_v21_project_money.sql`을 적용한다. SQLite는 append-only migration 21이다. v20은 사용하지 않는다.
- SQLite의 기존 `budget.project_id`, `transaction_record.project_id`, 양쪽 장부의 `budget_id`를 재사용한다. PG 예산/전표에는 nullable `project_id`를 추가한다. 예산의 nullable `money_currency`는 새 프로젝트 예산 생성만 `KRW`로 기록한다.
- 기존 예산/전표/통화는 UPDATE하지 않는다. 과거 프로젝트의 `budget_amount`와 PG `budgets.spent`는 집계에 사용하지 않는다. 알 수 없는 통화를 KRW로 바꾸지 않는다.

## API

SQLite `/projects/:projectId/money`, PG `/pg/projects/:id/money`:

- `GET`: `project_id`, `generated_at`, `basis:"explicit_posted_project"`, `scope`, `totals`, `budgets`, `entries`, `available_budgets`.
- `POST /budgets`: `{name,amount:"1000.01",currency:"KRW",account_id?:string|null}`. `Idempotency-Key` 필수, 201 `{id,project_id,version}`. 새 예산은 승인/활성 상태다.
- `POST /budgets/:budgetId/associate`: `{expected_version:1}`. `Idempotency-Key` 필수, 200 `{id,project_id,version}`. 미연결 예산을 명시 연결한다. 이미 다른 프로젝트에 연결된 예산은 409. 원래 통화가 불명확하면 계속 불명확하다. 과거 미연결 전표에는 영향을 주지 않는다.
- 금액은 항상 두 자리 소수 문자열이다. 입력 검증/합산은 decimal 문자열/BigInt, SQLite 개별 저장은 기존 안전한 minor 정수 경계를 따른다. 합산은 이 경계를 넘을 수 있다.

## 집계 의미

- `totals`는 `unit`별 배정 예산 `allocated`, 프로젝트 확정 지출 `spending`, `remaining=allocated-spending`이다. 예산 미선택이더라도 명시적으로 프로젝트에 연결된 확정 지출은 프로젝트 지출에 포함된다.
- `income`과 `net=income-spending`은 해당 단위의 실제 연결 수입 전표가 있을 때만 값이 있고 그 외에는 null이다. 차액도 잔여 예산도 은행 잔액이 아니다.
- 개별 `budgets[].spending/remaining`은 같은 프로젝트/예산/통화의 실제 확정 지출을 사용한다. 다른 통화와 합산하지 않는다. 통화 불명확 또는 불일치일 때 null이다.
- 기존 PG 통화 불명확 금액은 `ledger_decimal`, 기존 SQLite 통화 불명확 예산은 `currency_unspecified`로 분리한다. 실제 SQLite 전표 통화는 기존 `currency`다. 불명확 예산의 잔여 금액은 계산하지 않는다.
- 실제 빈 프로젝트는 `totals:[]`, `entries:[]`이다. 권한/기능 오류는 403 오류 응답이며 금액 DTO나 가짜 0을 반환하지 않는다.

## 쓰기·인가·보존

- 기존 ExpenseForm에 선택적 프로젝트 문맥을 추가했다. 새 expense 입력은 optional `project_id`를 받는다. 예산을 선택한 새 writer는 그 예산의 프로젝트를 새 전표에 snapshot한다. 명시 `project_id`와 선택 예산의 프로젝트가 다르면 거부한다. 수입은 예산 없이 `project_id`만으로 연결할 수 있다.
- 기존 PG `/finance/transactions`는 optional `project_id/budget_id`만 추가 수용하며 나머지 계약과 숫자 입력 호환은 유지한다. 기존 PG 미지정 통화를 KRW라고 표시하지 않는다.
- 프로젝트 재무는 현재 소속 + `menu.finance` + finance 모듈 + `transaction.read` + `budget.read` + `menu.projects` + `project.read`를 모두 확인한다. 예산 쓰기는 추가 `project.write/budget.write`, 지출은 기존 writer의 쓰기·확정 권한을 따른다.
- SQLite all 범위 또는 해당 프로젝트의 실제 활성 `project_member`를 가진 project 범위에서만 전체 조회를 검토한다. project 범위도 기존 `legacyReceiptParent`의 금융 행 권한과 예산 소유 범위를 따르므로 다른 작성자의 제한 행이 하나라도 있으면 금액 없이 전체 조회를 거부한다. self/department 범위를 회사 전체로 승격하거나 일부 행으로 전체 잔여를 만들지 않고 명시 거부한다. 미연결 예산 연결 후보는 all 외에는 본인이 만든 예산만이다. PG 역할은 기존 회사 all 범위 계약이다.
- 관계 검사는 같은 write transaction에서 실행한다. keyed replay 전에도 현재 프로젝트 접근을 검사한다. PG는 기존 회사 잠금/현재 재무 principal helper, SQLite는 현재 소속/역할 helper를 사용한다.
- 배정된 예산의 프로젝트/통화는 재배정하지 못한다. 게시 전표의 기존 immutable trigger를 보존하고 SQLite 과거 확정 전표의 귀속 변경도 막는다. 회사 복합 FK(PG) 또는 관계 trigger(SQLite)는 새 잘못된 관계를 거부한다. 과거 미연결 자료를 자동 귀속시키지 않는다.
- 예산 생성/연결은 예산+감사+replay를 한 transaction에 저장하고 연결은 version CAS를 검사한다. 원증빙/CSV writer의 caller-owned transaction 및 rollback 경계는 유지한다.

## 독립 수입 작업과의 통합

수입 worker의 전달 patch (`first-money.patch`, SHA256 `154ec69ec22d10fdf24736aa4d2d35df12fb7f68338d3b9daad5d8e6520d60ba`)를 통합했다. 전달된 `income-input.service.js` / `IncomeForm.tsx`에 optional `project_id` 문맥을 추가하며 지출 예산 입력은 수입에 허용하지 않는다. 프로젝트 패널의 수입 입력은 예산과 별도로 확정 수입을 기록한다. 성공 응답도 요청 프로젝트와 일치하는지 검증하고 불명확한 응답은 원래 키/본문으로 재시도한다. recovery delta (`first-money-retry.delta.patch`, SHA256 `933b813fac4fc4e1e8eae0141bb0c42b036291c7d5cd575b4f617eed1f4cf256`)도 통합했다. 프로젝트 입력은 서버 인증 사용자 ID의 `MoneyAttemptScope`를 사용하고 `initialAttempt.body.project_id`와 원래 예산/수입/지출 필드를 그대로 복원한다. v1 본문에 없던 `project_id`를 null이나 현재 프로젝트로 채우지 않는다. 다른 프로젝트 또는 미연결 보관 요청은 현재 프로젝트 폼에 표시하거나 옮기지 않고 재무 화면에서 원래 요청을 확인하도록 안내한다. 저장소 오류/다른 보관 요청이 있으면 새 입력을 막는다. partial-chart delta (`first-money-partial.delta.patch`, SHA256 `89b8e08f0a0e8eaa9111ab7133766742c4e42e9c6ce5001e6a311554e3546af3`)도 통합했다. 프로젝트 새 지출은 expense/cash, 새 수입은 income/cash의 `setup.missing`만 검사한다. 반대 방향 분류가 없다는 이유로 사용 가능한 입력을 막지 않으며 기존 보관 요청의 재시도는 유지한다. 파일 선택 창에서 돌아오는 focus 갱신은 작성 중인 프로젝트 재무 폼을 없애지 않고, 권한 변경 갱신은 유지한다. 최종 프로젝트 patch의 기준은 base 80c0f48 + income 원본 patch + recovery delta + partial-chart delta이며 수입 worker 변경을 중복 포함하지 않는다.
