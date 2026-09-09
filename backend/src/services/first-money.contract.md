# 첫 돈 관리 준비와 수입 입력

## 준비

- GET/POST `/finance/setup`, `/pg/finance/setup`.
- 응답 200: `{ready:boolean, can_initialize:boolean, missing:('cash'|'income'|'expense')[]}`. 누락 순서는 PG `cash,income,expense`, SQLite `income,expense`다.
- GET은 현재 소속·재무 모듈·`menu.finance`·`transaction.read`를 확인한다. POST는 엄격한 빈 객체 `{}`만 받으며 같은 트랜잭션에서 현재 `organization.settings` 권한도 확인한다. owner 또는 해당 조직 관리 권한을 가진 관리자의 명시적인 동작이다.
- POST는 회사 잠금(PG) / `BEGIN IMMEDIATE`(SQLite) 안에서 누락 방향만 추가한다. 재시도에 별도 요청 키가 필요 없고, 이미 준비되었으면 계정·감사 이력을 추가하지 않는다.
- 활성 호환 계정은 그대로 재사용한다. 비활성·다른 분류 계정의 코드/이름/유형을 덮어쓰지 않는다. 선호 코드가 사용 중이면 `-setup-N` 접미사로 새 코드를 선택한다.
- 조직 유형이 있으면 기존 `ORG_TEMPLATES` 계정을 사용한다. PG는 `to_jsonb(c)->>'organization_type'`으로 읽어서 유형 컬럼이 없는 기존 스키마에도 동작한다. 유형/분류가 없으면 `1000 현금`(PG 자산), `4100 수입`, `5100 지출`을 사용한다. SQLite 원장은 자산 계정을 요구하지 않는다.
- 생성 계정은 같은 트랜잭션의 감사에 남긴다: SQLite `finance.initialized`, PG `record_events.resource=finance_setup`. 거래·잔액·부서는 생성하지 않는다. 새 DDL은 없다.

## 수입

- POST `/finance/incomes`, `/pg/finance/incomes`; `Idempotency-Key` 필수(기존 재무 키 규칙).
- 본문: `{amount:string,currency:'KRW',income_date:'YYYY-MM-DD',payer:string,account_id:string,memo:string}`. currency 기본값 KRW, memo 기본값 빈 문자열. payer는 trim 후 1~200자, memo 최대 4000자, account_id 1~100자다. 금액은 양수 소수 2자리 이내이며 숫자 JSON은 거부한다. 날짜는 실제 달력 날짜이며 0000년은 거부한다.
- 알 수 없는 필드, 지출·증빙·예산·프로젝트 필드는 현재 거부한다. 프로젝트 연계 후속 작업은 입력 스키마와 정규화 payload를 함께 확장해야 한다.
- 정규화 payload: `kind:'income', amount, input_currency:'KRW', entry_date:income_date, counterparty:payer, account_id, memo`.
- 201 응답: 기존 확정 거래 writer 응답 + `kind:'income', income_date, payer`. `id`/`amount`는 문자열, `status:'confirmed'`. 호환 필드 `expense_date`는 같은 거래 날짜다.
- replay 작업명 `income.create`. SQLite tenant/org/actor, PG company/actor로 요청 키가 격리되며 다른 본문 재사용은 409다. 동일 트랜잭션에서 기존 원장 writer·감사·재생을 완료한다. 현재 소속/메뉴/모듈/동작 권한 검사는 재생보다 먼저 수행한다.
- SQLite `transaction.write` + `transaction.confirm`, PG `transaction.write`가 필요하다. 수입은 현재 조직의 활성 income/revenue 계정만 허용한다. 기존 expense의 expense-only 계정/영수증 가드는 유지된다. legacy generic 거래 API 필드 계약은 바꾸지 않는다.
- SQLite 상한 `90071992547409.91`, PG NUMERIC(18,2) 상한 `9999999999999999.99`. 반올림 없이 검증한다.

## 표시·재시도

- PG 거래 목록에 실제 분개에서 계산한 `income_amount`, `expense_amount` 문자열 및 `kind:'income'|'expense'|'journal'`을 추가한다. 기존 차변/대변 필드는 변경하지 않는다. 수익·비용 계정이 함께 있거나 둘 다 없으면 journal이다. 과거 기록의 통화·내용을 다시 분류하거나 저장하지 않는다.
- 화면은 수입·지출 분류와 정확한 기록 금액을 먼저 표시한다. 복합 전표는 원본 분개를 펼쳐 확인한다. 차변·대변/전체 CSV/이력/영수증은 유지한다. 차액은 기록한 수입−지출이며 은행 잔액이 아니다.
- 입력 성공 응답의 ID/확정 상태/정확한 금액/통화/분류/상대방/날짜/메모/증빙 구조를 검증한다. 잘린 응답, 불명확한 HTTP 응답, 네트워크 유실은 성공 처리하지 않고 키와 원래 본문을 보존한다. 재시도 동안 편집·다른 입력 전환을 잠근다. 회사/사용자 전환은 기존 컴포넌트 scope와 abort 경계를 따른다.
