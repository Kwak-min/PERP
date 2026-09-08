# CSV 실지출 가져오기 계약 (Task20 -> Task21)

Task21 UI는 이 변경에 포함하지 않는다. 모든 경로는 `/api/v1` 아래이며 Bearer + 선택 회사 `X-Org-Id`를 사용한다.

- legacy prefix: `/finance/transactions/imports`
- PG prefix: `/pg/finance/transactions/imports`
- 회사/store/actor는 인증에서만 정한다. 모든 응답은 `private, no-store`다.
- 모든 작업은 현재 `transaction.write`, `menu.finance`, finance 모듈을 요구한다. legacy는 `transaction.confirm`도 필요하다. 완료 replay에도 다시 검사한다. private job/upload는 같은 회사라도 다른 actor에게404다.

## 1. 원본 업로드

`POST <prefix>/uploads`, `Content-Type: text/csv`, body는 UTF-8 CSV **원본 bytes**다. JSON/base64/multipart/파일명 header는 사용하지 않는다. 인증 헤더를 포함한 raw 요청 helper를 `frontend/src/services/api.ts` 경계 안에서 구현해야 한다. 이 작업은 UI/helper를 추가하지 않는다.

응답201:

```json
{
  "upload_id": "uuid",
  "source": "legacy",
  "expires_at": "ISO instant",
  "raw_sha256": "hex",
  "parser_version": "expense-csv-v1:csv-parse@7.0.2",
  "logical_record_count": 2,
  "headers": [{"sourceOrdinal": 1, "name": "일자", "normalizedName": "일자", "suggestedTarget": "expense_date", "disposition": "mapped"}],
  "mapping_issues": []
}
```

raw 5MiB를 정확히 허용하며 HTTP/JSON/base64 overhead를 raw 크기에 더하지 않는다. 전역 JSON5mb 한도는 변경하지 않는다. 압축 전송은 받지 않는다. parser의 UTF8 fatal/BOM/RFC4180, 10000 data records, 20 columns, 4KiB cell 한도는 그대로다. 구조/UTF8 오류400, 크기 한도413이다.

업로드와 그 upload를 공유하는 모든 preview의 원본 내용은 업로드 후24h에 만료된다. 새 preview를 만들어도 보존 기한은 연장되지 않는다. cleanup 실행 전에도 preview 생성, job/rows 조회, 미완료 commit에서 만료를 검사한다. raw는 다운로드 API, 공개 로그, 감사 이벤트로 내보내지 않는다. 만료 후 DTO는 아래 계약을 따른다.

물리 정리는 `cleanupLegacyExpenseImports()` / `cleanupPgExpenseImports()` 또는 `node scripts/cleanup_expense_imports.mjs legacy|perp_db`로 실행한다. 반환값은 `{deleted,redacted}`(삭제한 upload 수, audit-only snapshot으로 전환한 job 수)이며 재실행은 안전하다. superseded/invalid/ready/completed 모두 정리한다. 삭제된 upload를 참조하는 남은 preview도 정리한다. 운영 스케줄러의 정기 실행, 실패 알림/재시도, DB/WAL/backup 보존 정책 연결은 **필수 deployment wiring**이다. scheduler 설치나 운영 실행을 수행했다는 주장이 아니다. 이 정리는 DB의 live content를 삭제/교체하며 backup이나 forensic secure erase를 대신하지 않는다.

SQLite cleanup은 commit과 같은 `BEGIN IMMEDIATE` write lock을 사용한다. 경합 시 SQLITE_BUSY는 성공이 아니며 운영 job이 재시도해야 한다. PG cleanup은 회사 ID 순서로 commit과 같은 회사 lock을 먼저 잡고 만료를 다시 검사한 뒤 job redaction과 upload 삭제를 한 transaction에서 수행한다. 이미 유효한 입력을 읽고 진행 중인 commit을 정리가 추월하지 않는다. 완료 후 정리할 수 있다. 활성 upload/input, 장부/영수증 원본 및 공유 파일, identity claims, 감사/replay/result는 삭제하지 않는다.

## 2. 불변 미리보기

`POST <prefix>` JSON:

```json
{
  "upload_id": "uuid",
  "provider_source": "manual_csv",
  "mapping": [{"sourceOrdinal": 1, "target": "expense_date"}],
  "account_mapping": [{"account_code": "EXP", "account_id": "실제 선택 회사의 활성 지출 계정 ID"}],
  "mapping_confirmed": true,
  "no_receipt_reason": "원증빙을 보관하지 못함",
  "excluded_ordinals": [],
  "duplicate_ordinals": [],
  "receipts": [{"logicalRecordOrdinal": 1, "receipt_tokens": ["기존 transaction 영수증 업로드 token"]}],
  "replaces_job_id": "선택 사항: 대체할 같은 upload의 미완료 job UUID"
}
```

- `mapping` 생략은 parser header 제안을 채택한다. 지정할 때 sourceOrdinal은1부터, target은 `external_id|expense_date|merchant|amount|currency|account_code|memo|null`이다. null/누락 열은 무시 대상으로 표시한다. 중복 target 또는 필수 target 누락은 ready가 아니다.
- `account_mapping`은 CSV 계정 코드 -> 현재 회사 account ID의 명시 매핑이다. 임의의 이름/코드 유사도로 계정을 채택하지 않는다. `mapping_confirmed` 기본false다. 자동 제안을 보았더라도 사용자가 매핑을 확인해야 true로 보낸다.
- provider 기본 `manual_csv`, 형식 `[a-z][a-z0-9_.-]{0,63}`. 파일명이 아닌 사용자가 선택한 안정된 provider namespace다.
- 영수증 없는 선택 행은 import-level `no_receipt_reason`이 필수다. receipts는 기본[]이며 row token은 기존 소비 계약의 actor/company/kind/만료/5개/25MiB를 따른다. 같은 token을 여러 행에 배치할 수 없다. receipt staging URL/path/file ID는 채택하지 않는다.
- 제외/중복 확인 ordinal은 **필터 전 원본 논리 data record의1-based 번호**다. 원본 header는 포함하지 않는다. excluded는 명시 선택만 허용하며 오류 행을 제외해도 다른 행 ordinal을 재번호하지 않는다.
- 이미 저장된 동일 identity/payload는 `duplicate_ordinals`에 명시 확인해야 reuse한다. 확인 전에는 `DUPLICATE_CONFIRMATION_REQUIRED` 오류다. 비슷한 날짜/금액/사용처는 경고일 뿐 자동 제외하지 않는다.
- body 수정은 항상 새 job이다. 같은 upload의 새 preview 생성은 이전 ready/invalid job을 자동 superseded로 만든다. 완료 job은 보존한다. optional replaces_job_id는 같은 actor/upload의 현재 미완료 job인지 검증한다.
- JSON 알 수 없는 필드/중복 source 매핑/범위 밖 ordinal400. 행 오류가 있어도 job 생성201이며 state는invalid다.

응답201과 `GET <prefix>/:jobId` 공통 DTO:

```json
{
  "job_id": "uuid", "upload_id": "uuid", "source": "legacy|perp_db",
  "state": "ready|invalid|superseded|completed", "created_at": "ISO instant", "content_expired": false,
  "raw_sha256": "hex", "parser_version": "version", "provider_source": "manual_csv",
  "headers": [], "mapping": [], "account_mapping": [], "mapping_confirmed": true,
  "excluded_ordinals": [], "duplicate_ordinals": [], "no_receipt_reason": "사유",
  "issues": [],
  "summary": {"total": 2, "selected": 2, "excluded": 0, "errors": 0, "duplicates": 0, "amount": "200.02"}
}
```

amount는 선택한 canonical 변환 성공 행 금액 합계의 exact decimal string이다. 변환 실패 행은 제외하지만 중복 확인 대기/충돌 행의 canonical 금액은 포함되므로 invalid 상태 합계를 확정 장부 금액처럼 표시하면 안 된다. completed summary에는 created/reused도 있다.

## 3. 페이지 조회

`GET <prefix>/:jobId/rows?offset=0&limit=25&filter=all`

- offset0..10000, limit1..100(기본25), filter=`all|errors|duplicates`.
- `{job_id,state,offset,limit,total,items}`. total은 필터 후 전체 수이며 silent truncation이 아니다.
- item: `{logicalRecordOrdinal,values,valid,issues,warnings,disposition,duplicate_confirmed,existing_id,result}`.
- values는 parser canonical `{externalId,expenseDate,merchant,amount,currency,accountCode,memo}` 또는 invalid 시null이다. 사용처/메모 공백은 보존한다.
- disposition=`create|reuse|excluded`; result는 완료한 생성/재사용 행의 `{id: string}` 또는null이다. 장부 상세/영수증 조회는 기존 transaction API를 사용한다.
- issues는 machine code와 logicalRecordOrdinal을 포함한다. 중요 코드: `INVALID_EXPENSE_INPUT`, `INACTIVE_ACCOUNT`, `IDENTITY_PAYLOAD_CONFLICT`, `DUPLICATE_CONFIRMATION_REQUIRED`, `DUPLICATE_NOT_FOUND`. mapping/global 문제는 job의 issues를 함께 표시한다.

### 만료 후 job / rows

- `GET /:jobId`는 현재 권한과 private scope를 검사한 뒤200. `content_expired:true`와 `job_id,upload_id,source,state,created_at,raw_sha256,parser_version,summary`만 반환한다. 상태는 역사적 상태를 유지하며 새 expired state를 만들지 않는다. 미완료 summary는 `total,selected,excluded,errors,duplicates` 건수만, completed summary는 원래 완료 결과(금액/created/reused 포함)를 그대로 유지한다.
- headers/mapping/account_mapping/provider_source/이유/issues/행 values/쓰기 payload/receipt token은 더 이상 조회할 수 없다. client도 만료 응답을 받으면 캐시한 원본/preview를 폐기해야 한다.
- 미완료(ready/invalid/superseded)의 `GET /:jobId/rows` 및 `POST /:jobId/commit`은410 `IMPORT_CONTENT_EXPIRED`. 다시 업로드하고 새 preview를 만들어야 한다.
- completed rows는200 `{job_id,state,content_expired:true,offset,limit,total,items}`. item은 `{logicalRecordOrdinal,disposition,result}`만 유지하며 제외 행은 result:null이다. `all`은 원래 ordinal 전체, `duplicates`는 reuse 행만, `errors`는 빈 페이지(total0)다. 동일 pagination 한도를 적용한다. 장부의 사용처/금액/메모/증빙은 기존 권한 있는 transaction API에서 조회한다.
- completed 같은 키 replay는 만료/물리 정리 후에도 원래 결과를 반환한다. 현재 권한/회사/선택 계정 상태를 다시 검사하며 다른 키409, 잘못된 commit 본문400은 그대로다.

## 4. 원자 적용 / 응답 유실 복구

`POST <prefix>/:jobId/commit`, **정확한 JSON `{}`**, 필수 `Idempotency-Key`(1..128 visible ASCII).

CSV/rows/mapping/scope/기타 필드, array/null, query override는400이다. 본문 없는 요청(길이0 JSON 및 빈 chunked 전송 포함)도 신규 쓰기와 replay 전에400이다. 실제 JSON 빈 객체 `{}`는 일반/분할 전송 모두 유효하다. 클라이언트는 job ID와 생성한 key를 보존한다. 응답 유실 뒤 GET job과 rows로 상태를 확인하거나 같은 key+job을 재시도한다. 다른 key로 완료 job을 다시 적용하면409, 같은 actor/company key에 다른 job도409다.

응답200:

```json
{"job_id":"uuid","state":"completed","summary":{"total":2,"selected":2,"excluded":0,"errors":0,"duplicates":0,"created":2,"reused":0,"amount":"200.02"}}
```

commit은 현재 회사/권한을 먼저 잠그고 조회한 다음 job, 참조 계정, replay/identity를 검사한다. SQLite는 단 하나의 동기 `withLegacyFinanceTransaction`, PG는 단 하나의 `withPgFinanceTransaction`과 그 client를 사용한다. canonical writer, 모든 journal/lines/receipt/audit/identity/replay/job-result가 함께 COMMIT되거나 전부 ROLLBACK된다. row별 transaction과 partial success는 없다.

- 만료 전 invalid/superseded409. 미완료 만료 후에는410 `IMPORT_CONTENT_EXPIRED`. inactive 계정은 `IMPORT_ACCOUNT_CHANGED`409이고 새 preview가 필요하다.
- preview 이후 다른 actor/import가 동일 identity를 차지하면 `IMPORT_IDENTITY_CHANGED`409, 전체 rollback. 새 preview에서 duplicate를 확인한다. completed replay도 현재 권한/계정을 먼저 검사한다.
- 영수증 현재 소비 가능 여부는 canonical writer가 같은 transaction에서 다시 검사한다. 만료/외부/소비한 token 때문에 실패해도 앞선 행까지 rollback한다.
- 예상하지 못한 DB/audit/job-result 실패500은 적용 성공이 아니다. 조회/동일key 재시도 전 클라이언트 CSV나 행을 commit에 재전송하지 않는다.

## identity / 보존 / migration

store별 회사-wide identity는 `["external_id",provider_source,external_id]`, 또는 `["raw_record",raw_sha256,originalLogicalOrdinal]`다. actor를 UNIQUE key에 넣지 않는다. 무 external ID의 완전히 같은 두 행은 ordinal이 다르므로 둘 다 저장한다. 파일 내용/순서/encoding 변경은 fallback identity가 달라지며 cross-file fuzzy dedupe를 약속하지 않는다.

DB PK는 회사 + 이 canonical identity의 SHA256이다. PG의 4KiB external ID가 btree tuple 한도를 넘지 않게 하며 PG CHECK가 identity_value와 SHA256의 일치를 강제한다. SQLite는 원 identity_value의 회사-wide UNIQUE도 둔다. 양쪽 모두 **정확한 identity_value와 정규화 payload digest를 비교**하여 hash 충돌/다른 payload를 재사용하지 않고 충돌로 막는다. identity claims는 회사-scoped journal 및 job FK를 가진 append-only 기록이다.

job의 source/actor/company/upload/created_at과 별도의 `audit_snapshot`은 DB trigger로 불변이고 completed result/result_rows/request_key는 변경/삭제할 수 없다. preview `snapshot`에는 단 하나의 좁은 예외가 있다: upload가 만료되었거나 삭제되었을 때만, 다른 필드를 모두 그대로 둔 채 사전에 고정한 `audit_snapshot`과 정확히 같은 값으로 한 번 전환할 수 있다. 그 외 snapshot 변경/복원/삭제는 금지된다. audit_snapshot은 hash/parser/건수와 현재 계정 검사용 선택 행 ordinal+account ID만 보존한다. 셀 값/원본 external ID/매핑 이름/이유/receipt token/쓰기 payload는 보존하지 않는다. 실제 committed identity_value와 digest는 기존 append-only identity claims에 보존한다. import audit에는 hash/parser/원본 ordinal과 장부 ID/건수만 들어간다. 업무 금액/사용처/메모는 기존 canonical 장부 writer 감사 계약을 유지한다. 새 원장/환급/송금/OCR/외부AI 호출은 없다.

- SQLite: 기존1..10 후 **13**. approvals11/Wiki12를 점유하지 않는다.
- PostgreSQL: verified finance/role base 후 `db/perp_additions_v16_deadline_expense_imports.sql`. v13/v14 approvals, v15 Wiki와 분리한다. 운영 적용은 수행하지 않았다.
- 이 revision은 미배포 Task20 migration13/v16을 수정한다. 이전 초안 DDL을 적용한 임시 환경은 새 격리 DB로 검증했다. 운영 migration은 적용하지 않았다.
- 현재 parser dependency와 새 upload/preview provenance는 Task37에서 검증을 마친7.0.2다. 저장된 과거6.1.0 provenance와 완료 replay 결과는 변경하지 않는다. 만료 전 persisted ready6.1.0 job은 신뢰된 저장 snapshot을 재파싱하지 않고 commit할 수 있지만, client에 캐시된6.1.0 parse DTO는7.0.2로 새 parse/preview해야 한다. upload가 만료되었으면 다시 업로드해야 한다.
