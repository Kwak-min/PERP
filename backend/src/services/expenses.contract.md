# 실지출 입력 계약 (Task 17 -> 18/20/24)

## HTTP

모든 경로는 `/api/v1` 아래, Bearer와 선택 회사 `X-Org-Id`를 사용한다. PG 회사는 `pg:<id>`다.

| 작업 | legacy | PG |
| --- | --- | --- |
| 실지출 생성 POST | `/finance/expenses` | `/pg/finance/expenses` |
| 거래 목록 GET (기존 경로) | `/finance/transactions` | `/pg/finance/transactions` |
| 거래 상세 GET | `/finance/transactions/:id` | `/pg/finance/transactions/:id` |
| 사후 영수증 추가 POST | `/finance/transactions/:id/receipts` | `/pg/finance/transactions/:id/receipts` |

업로드/다운로드는 `receipt-files.contract.md`의 기존 경로를 그대로 사용한다. 실지출 생성과 사후 추가는 `Idempotency-Key`(1-128 ASCII visible characters)가 필수다. 같은 actor/company/operation/key와 같은 정규화 payload는 기존 응답을 반환하고, 다른 payload는409다. replay도 현재 소속/역할/menu.finance/finance module을 다시 확인한다.

### 생성 본문

```json
{
  "amount": "100.01",
  "currency": "KRW",
  "expense_date": "2026-09-08",
  "expense_time": "12:34:56",
  "merchant": "사용처",
  "account_id": "인증 회사의 계정 ID",
  "budget_id": null,
  "memo": "메모",
  "receipt_tokens": [],
  "no_receipt_reason": "영수증 분실"
}
```

- `amount`는 반드시 문자열인 exact positive NUMERIC(18,2)다. 반올림/지수/부호/JS Number는 새 API에서 받지 않는다. legacy는 minor가 MAX_SAFE_INTEGER를 넘으면400이며 최대 `90071992547409.91`까지 정확하다.
- `currency` 생략은 KRW이며 다른 값은400이다. 기존 다른 통화/과거 null metadata는 변환하지 않는다.
- `expense_date`는 실제 ISO date(연도0000 제외), `expense_time`은 선택한 Asia/Seoul 벽시계 `HH:mm` 또는 `HH:mm:ss`다. 시각 생략은 occurred_at=null이며 자정을 추측하지 않는다. 시각 입력은 UTC instant로 저장한다.
- `merchant`는 trim 후1-200자, `memo`는 최대4000자/기본 빈 문자열이다.
- active expense account 필수다. 예산 선택 시 같은 회사의 PG active/legacy approved 예산과 그 계정의 일치를 확인한다. legacy block 예산 초과는409다. PG spent cache를 갱신하거나 새 실행 금액 원장을 만들지 않는다.
- `receipt_tokens`는 기본 빈 배열이며 기존 소비기의5개/25MiB/현재 actor/company/kind/만료 계약을 따른다. 빈 배열이면 trim 후1-1000자의 `no_receipt_reason`이 필수다. 알 수 없는 필드, file_id/path/URL 채택은400이다.
- PG는 기존 transaction.write로 게시한다. legacy는 transaction.write와 transaction.confirm 둘 다 필요하다. 기존 권한을 자동 부여하지 않는다.

응답201은 `id,status:"confirmed",amount,counterparty,occurred_at,expense_date,account_id,budget_id,memo,no_receipt_reason,receipts,version`을 포함한다. legacy는 안전한 `amount_minor`와 기존 거래 DTO 필드도 유지한다. PG의 `receipt_version`은 게시 UPDATE의 실제 `xmin::text`이며 정수 `version`과 다른 토큰이다.

상세는 기존 장부 행과 인가된 영수증 metadata를 반환한다. PG 상세 amount는 실제 journal_lines/account 방향으로 계산하고 nullable metadata에서 금액을 집계하지 않는다. PG 상세는 실제 journal_lines의 `lines:[{id,account_id,account_type,debit,credit}]`도 반환한다(ID/금액은 문자열). 지출/수입 계정이 하나면 `account_id`는 그 실제 계정 ID이며, 여러 계정이거나 없으면 null이다. 과거 계정의 비활성화는 상세의 계정/lines를 숨기지 않는다. `/pg/finance/accounts`는 기존 value/label에 `account_type:"expense"|"revenue"`를 추가하며 현재 회사의 활성 계정만 반환한다. legacy `/finance/accounts`도 현재 회사의 활성 계정만 반환하고 기존 `kind:"expense"|"income"`을 유지한다. legacy 목록의 새 실지출 evidence_count는 현재 link에서 계산하므로 사후 첨부를 위해 원본을 수정하지 않는다.

### 사후 추가 본문

`{ "expected_version": <부모 토큰>, "receipt_tokens": ["업로드 token"] }`만 허용한다. legacy 토큰은 정수 `version`, PG 토큰은 문자열 `receipt_version`이다. PG integer version=1을 넘기면 안 된다. 토큰 배열은 비어 있을 수 없다. 원본 전표/lines/업무 metadata는 수정하지 않고 link와 receipt audit를 append한다. 생성 당시 미첨부 사유도 역사적 원본으로 남긴다.

### 기존 POST 호환

- `/finance/transactions`는 기존 `{kind,amount_minor,occurred_on,account_id?,counterparty_id?,project_id?,budget_id?,memo?}`를 받아 계속 draft를 만든다. 기존 confirm 흐름을 강제로 새 실지출로 바꾸지 않는다. Idempotency-Key 생략도 유지하고, 제공되면 payload-aware replay를 적용한다. unsafe minor/잘못된 실제 날짜/회사 참조는 거부한다.
- `/pg/finance/transactions`는 기존 `{account_id,amount,entry_date?,memo?}`와 필수 key를 유지한다. 기존 안전한 numeric amount도 받아 canonical decimal로 정규화한다. revenue/expense 방향을 보존하고 새 strict 입력 metadata를 추측하지 않는다.
- 두 old POST는 위의 기존 필드만 허용한다. merchant/expense_date/expense_time/currency/receipt_tokens/no_receipt_reason 등 새 지출 필드 또는 혼합/미지원 필드는400이며 버리거나 성공 replay하지 않는다. 새 지출은 `/finance/expenses` 또는 `/pg/finance/expenses`로 보내야 한다. 유효한 strict 생성/영수증 흐름은 그대로 지원한다.
- 두 저장소 모두 old POST와 새 expense POST가 같은 저장소별 canonical writer를 호출한다. replay 비교는 소비하는 모든 canonical 필드(사용처/일자/시각/금액/통화/계정/예산/메모/사유/영수증 token)를 포함한다.

## 후속 구현용 transaction 함수

- `expenseInput(body)` (`expense-input.service.js`): strict HTTP/정규화 입력 경계. 출력은 canonical payload이며 PG금액은 끝까지 문자열이다.
- `withPgFinanceTransaction(req, run)`: BEGIN 뒤 가장 먼저 회사 FOR UPDATE와 현재 membership/grants/menu/module을 검사하고, `run(client, principal)`의 전체 성공 후 COMMIT 한 번. 오류는 전체 ROLLBACK이다.
- `replayPgMutation(client, req, {operation,payload}, run)` (`pg-finance.service.js`): caller-owned transaction에서 replay 저장/응답을 처리한다. 위 회사 lock/fresh 인가보다 먼저 호출하지 않는다.
- `postPgTransaction(client, req, canonicalPayload)` (`pg-expenses.service.js`): 위 transaction 안에서 account/budget 검증, 기존 journal/두 lines/게시, 실제 게시 xmin으로 receipt 소비, record_events를 쓴다. 자체 BEGIN/COMMIT 없음. 같은 client를 계속 넘긴다.
- `withLegacyFinanceTransaction(req, run)`: BEGIN IMMEDIATE/현재 회사 인가/동기 callback/한 COMMIT. Promise callback을 넘기지 않는다.
- `replayLegacyMutation(req, principal, {operation,payload,keyRequired?}, run)`: 위 동기 transaction에서 scoped payload-aware replay와 결과를 저장한다.
- `writeLegacyTransaction(principal, canonicalPayload, requestId)`: 같은 동기 transaction에서 기존 transaction_record/receipt 소비/audit를 쓴다. 새 KRW canonical payload는 confirmed, 기존 legacy payload는 draft다. strict 소비자는 callback 진입 시 transaction.confirm도 확인하여 replay에도 적용해야 한다.
- 사후 첨부 내부 함수: `appendPgExpenseReceipts(client, principal, {parentId,expectedVersion,tokens})`, `appendLegacyExpenseReceipts(principal, ...)`. HTTP adapter와 같은 fresh 권한/replay 경계를 사용한다.

CSV 후속 작업은 회사 lock 다음 job lock을 잡고, immutable snapshot/identity claim/전행 writer/link/audit/replay/job result를 이 하나의 native transaction에 넣어야 한다. writer마다 새 transaction을 열지 않는다. 이번 작업은 CSV job/parser/UI를 구현하지 않았다.

## 마이그레이션 / 보존

PG 순서: 기존 v1-v10 -> `perp_additions_v12_deadline_expenses.sql` -> `perp_additions_v12_deadline_expense_writer.sql`. 마지막 파일은 nullable budget_id와 회사 복합 FK만 추가하며 기존 금액/자료를 바꾸지 않는다. 두 파일 모두 native에서 두 번 적용했다. task22의 v13/v14 enum migration 번호를 점유하지 않는다.

SQLite migration10은 scoped payload-aware `finance_request_replay`와 새 confirmed KRW 원본 update/delete 금지 trigger를 추가한다. 기존 posted PG는 v8 trigger를 그대로 유지한다. 과거 legacy agent의 draft-confirm-rollback 흐름은 input_currency가 없는 과거 경계로 보존하며, 새 실지출에는 적용할 수 없다. 일반 legacy PATCH는 confirmed 원금/본문을 거절한다. receipt 원본/link 보존은 task16 trigger를 유지한다.

별도 원장, settlements 환급 workflow, 송금/세금계산/OCR/자동결제는 추가하지 않았다. 기존 legacy summary의 Number 기반 대규모 합산은 분석/CSV의 exact BigInt 집계 대체물이 아니다. task20/24는 실제 confirmed minor rows를 BigInt로 합산해야 한다.
