# 재무 화면 연결 계약 (Task 18 -> 21)

- `screenOverrides['FIN-001'|'FIN-002']`는 `ExpenseScreen`을 사용한다. 저장소는 로그인 token과 선택 orgId로 고정하며 이 둘 중 하나가 바뀌면 화면 scope를 새로 만든다.
- `/finance/transactions?new=expense`는 수동 지출 입력, `?transaction=<실제 전표 ID>`는 서버 상세 재조회 진입점이다. URL에는 인증정보를 넣지 않는다.
- `ExpenseForm({session,onSaved(id),onClose})`는 strict `/finance/expenses` 또는 `/pg/finance/expenses`만 사용한다. `onSaved`는 confirmed 응답 검증 뒤 한 번 호출된다. 응답 유실은 같은 payload/key로 재시도한다.
- `ExpenseWorkspace`의 `revision`은 목록 재조회 신호다. 수동 생성/상세 첨부 완료가 `setRevision(n => n + 1)`을 호출한다. Task 21은 기존 헤더 `expense-actions`에 CSV 검토 진입점을 추가하고, 서버 commit 성공 뒤 동일한 목록 재조회 신호를 사용하면 된다. CSV 입력과 job 상태를 수동 지출 폼 state에 섞지 않는다.
- `ledgerRows`는 전체 목록 DTO 어댑터다. PG는 실제 전체 목록, legacy는 기존 지원 query `?limit=-1`을 요청한다. 기본 100건을 전체라고 표시하거나 client page 10건만 CSV로 내보내지 않는다. 검색과 CSV는 조회한 전체 배열을 사용한다.
- `ExpenseDetail`은 매 진입/재조회 때 실제 전표·분개·영수증을 다시 읽는다. `receipt_version`(PG)과 `version`(legacy)을 구분하며 사후 첨부는 감사된 append다.
- `ReceiptUploads`는 raw upload와 대기/실패/재시도 state를 제공한다. 원본 미리보기나 원본 thumbnail은 없다. 다운로드는 인증 `apiBlob` + 실제 filename + 즉시 objectURL revoke를 사용한다.
- CSV parser/job/매핑/검토/commit UI는 이 작업에 없다. Task 21은 Task 20 서버 계약을 먼저 통합해야 한다. 기존 CSV **내보내기**와 모든 수입·초안·확정 기록 조회는 보존한다.
