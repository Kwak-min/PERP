# 관리자 매뉴얼 (Administrator Manual)

대상: 회사(조직) 전체 관리자 / 위임받은 역할 관리자 / 감사자

이 문서는 실제 화면과 API 계약을 기준으로 씁니다. 화면에서 버튼이 보이지 않는 것은
UX일 뿐이며 API 직접 호출도 같은 규칙으로 403/404/409를 반환합니다. 저장소(legacy
SQLite 조직 또는 `pg:<company_id>` PG 회사)에 따라 다른 규칙은 각 절에서 따로 적습니다.

## 1. 조직 최초 설정
1. **조직 생성**: `/onboarding/organization`에서 유형(동아리·학생회·연구실·스터디·비영리·기업)을
   선택하면 용어·기본 부서·계정과목·모듈이 구성된다.
2. **부서·브랜치**: `/org-chart`(ORG-003)와 `/settings/branches`(ORG-005). 부서·브랜치는
   관리자가 명시적으로 추가한 항목만 생성되며 샘플 데이터는 없다.
3. **회원 초대·등록**: `/members`(ORG-002). 초대는 14일 후 만료되고 회수·재발송이 가능하다.
   구성원 목록과 구성원 선택 모달은 **10건씩** 페이지로 보이며 이름·이메일·역할·부서·상태로
   검색한다. 서버 limit로 전체 검색을 자르지 않는다.
4. **역할과 권한**: `/settings/roles`(ORG-004). 아래 2절.
5. **모듈·기능**: `/settings/organization`(ORG-001)의 "모듈 및 기능 설정". 근태·휴가 같은
   기능을 끄면 메뉴와 실제 API가 차단되고 **자료와 권한 grant는 보존**된다. 관리자도 꺼진
   기능을 우회하지 못하며, 역할을 수정해도 기능이 켜지지 않는다. 화면은 꺼진 기능을
   "꺼짐 (저장 권한 유지)"로 표시한다.
6. **모집 메뉴**: 사람 사이드바에서 모집 링크(HR-004)는 제거됐다. 직접 URL `/hr/recruitment`와
   기존 모집 데이터·권한은 그대로이며, 즐겨찾기에도 노출되지 않는다.

## 2. 권한 관리

### 회사 관리자와 역할 합집합
- **회사 전체 관리자**는 scope `all`에서 `COMPANY_PERMISSIONS`의 유한 전체 집합을 가진 역할이다.
  회사 간, 플랫폼, 다른 사람의 개인 Vault 소유권은 우회하지 못한다. 옛 owner `*`는 호환용으로만
  인식한다.
- 한 회원의 유효 권한은 배정된 역할의 **합집합**이다. 비활성 기능의 grant도 계산에 포함된다.
- **마지막 전체 관리자 보호**: 활성 회원의 역할 합집합으로 판정하며, 마지막 관리자를 강등·비활성
  하려는 요청은 409로 거절된다. 관리자가 이미 없는 회사는 화면에 "활성 회사 전체 관리자가
  없습니다. 관리자 복구가 필요하며 권한을 자동으로 부여하지 않습니다."가 표시되고, 운영자가
  소유권을 확인한 뒤 복구해야 한다. SQL로 직접 승격하지 않는다.

### 역할 설정 화면 (`/settings/roles`)
- 역할은 "접근 가능한 메뉴", "실행 가능한 업무 동작", 위임(`role.assign`)을 별도 묶음으로
  저장한다. 기본 역할과 사용자 정의 역할을 구분한다.
- 역할 정의 DTO는 `{id,name,scope,permissions,version,system}`이다. 생성은 버전 없이,
  수정·삭제는 `expected_version`이 필수다. 회원 배정 교체는 `{roles,expected_roles_version}`이며
  `roles_version`은 일반 membership version과 독립이다.
- 다른 관리자가 먼저 저장했으면 409가 나고 **내 초안은 보존**된다. 화면은 초안과 최신 저장값을
  나란히 비교하며, 비교 확인은 저장이 아니다. 저장 권한이 먼저 사라졌다면 403이다.
- `role.assign`은 역할 정의 생성·변경·삭제와 회원 배정·회수의 공통 위임 gate다. settings 화면의
  `menu.roles`, 회원 경로의 `menu.members` 같은 원래 surface gate도 함께 요구된다. `menu.roles`만
  회수해도 모든 위임이 사라지는 것은 아니다.
- **PG 회사의 역할 scope는 `all`만** 지원한다. 화면에 "PG 역할은 회사 전체 범위만 지원합니다."가
  표시되며 department/self grant를 합성하지 않는다. legacy 조직은 all/department/project/self를
  쓴다.
- 회원 CSV 가져오기(`/api/v1/imports`)는 insert-only이며 기존 사용자의 역할을 덮지 않는다. 모든
  역할 경로(초대·provision·import)는 현재 회사 권한으로 다시 해석된다.

### 프로젝트 구성원·업무 배정
- "프로젝트 구성원 추가"는 선택 회사의 활성·승인 구성원만 후보로 보이며 후보 DTO는
  `{id,name,department_name,already_member}`만 담는다. 개인정보 전체 directory 권한을 새로 주지
  않는다.
- 이미 구성원이면 200 `{created:false}`, 새 추가는 201 `{created:true}`이며 화면이 roster를 다시
  읽는다.
- 업무 배정이 수신자에게 역할을 자동 부여하지 않는다. 권한이 없는 수신자는 알림·업무를 못 볼 수
  있다는 안내가 관리자에게 표시되고 역할 화면으로 연결된다.

### 권한 판정 공통
- 서버 판정: 인증 → 테넌트·멤버십 → resource/action → scope → 필드 마스킹 → 채널 정책 → 감사기록.
- `POST /api/v1/permissions/simulate`로 역할·권한 조합을 사전에 확인한다.
- 개인정보 필드(phone/address/birth_date/emergency_contact)는 본인·인사·관리자 외 `***` 마스킹.

## 3. 회계 통제

| 작업 | 화면 | 통제 |
|---|---|---|
| 거래 등록 | `/finance/transactions`(FIN-002) | 등록은 `draft`, 원장 미반영 |
| 거래 확정 | 동일 | `transaction.confirm` 권한자만, 확정분만 원장·집행률 반영 |
| **실지출 입력** | 동일 화면의 지출 입력 | 금액·사용처(1~200자)·실제 날짜·선택 시각·활성 지출 계정·메모·영수증 또는 미첨부 사유. 신규 입력 통화는 KRW, 기존 다른 통화 자료는 변환·삭제하지 않음. 성공은 곧 확정 장부 기록이며 금액 수정 버튼이 없음 |
| **원증빙** | 동일 | JPEG/PNG/PDF만, 개별 10MiB, 부모당 5개/25MiB. 확장자·MIME·magic·실제 decode·암호화 PDF 거부. malware scan·OCR이 아님. 소비된 원본과 link는 수정·삭제 불가, 사후 추가는 감사 이력과 함께 append만 |
| **CSV 지출 가져오기** | `/finance/transactions`의 "CSV 지출 가져오기" | 아래 7절. `transaction.write`, `menu.finance`, finance 모듈 필요, legacy는 `transaction.confirm`도 필요 |
| 마감 | `/finance/close`(FIN-006) | 마감 기간 거래 생성·수정은 409 `PERIOD_LOCKED` |
| 재오픈 | 동일 | 승인된 결재가 있어야만 가능 |
| 정산 | `/finance/settlements`(FIN-005) | 승인 전 원장 반영 불가(409 `APPROVAL_REQUIRED`). 실지출의 금액 원천은 정산이 아니라 기존 전표/확정 거래다 |

- PG 금액은 `NUMERIC(18,2)` 문자열, legacy는 정수 minor 단위다. 범위를 넘는 값은 400이며 반올림해
  받지 않는다.
- 자동 송금·환급·세금 계산·카드/국세청 연동·OCR은 없다. 화면에서도 그런 기능을 암시하지 않는다.
- 원본 삭제 정책은 자동이 없고, 이 구조가 법적 보존 기간을 충족한다고 주장하지 않는다.

### 결재 통제 (`/approvals`, `/settings/approval-forms`)
- 상태: PG는 draft/pending/approved/rejected/withdrawn, legacy는 기존 상태와 hold(보류)를 유지한다.
  hold는 후속 완료를 막는 열린 상태이며 원래 보류한 담당자가 재개한다.
- 결정자 경계는 저장소마다 다르다. **PG**는 회사의 non-draft authorized-decider pool, **legacy**는
  실제 배정된 순차 step + `approval.decide`다. 미배정 회사 관리자는 legacy 요청을 결정할 수 없다.
  화면은 "저장된 결재 경로와 실제 배정된 요청을 확인합니다."로 이 차이를 알린다.
- 단일 terminal decision + row lock. 중복 결정은 409, 반려 사유 공백은 400. 본인 요청을 직접
  결정할 때는 명시 확인 체크와 감사 표시가 필요하다. 고액·legacy 재인증은 생략하지 않는다.
- 종결 원본은 불변이다. 재상신은 `predecessor_id`로 연결된 **새 draft**를 만들고 멤버십·양식·
  첨부를 다시 검증한다. 요청자 철회(withdraw)는 pending에만 가능하다.
- 기본 양식은 일반 요청/지출 검토/구매 요청이며 제목·목적 필수, 금액형은 정확한 KRW 필수.
  양식 변경은 `/settings/approval-forms`(SET-001)에서 기존 form 권한으로만 하고, 제출 시 양식
  revision과 필수 필드를 snapshot으로 검증한다. 과거 요청은 "기존 기록에 양식 snapshot 없음"으로
  표시한다.
- 첨부는 부모 결재의 read 권한을 상속한다. 제출 뒤 `workflow_locked`된 첨부는 추가·교체·삭제할 수
  없다. legacy 다운로드는 requester와 실제 배정 reader만, PG는 requester 또는 decider pool만.

## 4. AI 정책 관리 (`/admin/ai-policy`)
- **데이터 등급별 라우팅**: `sensitive`/`confidential`은 외부 LLM 전송이 차단되고 로컬 모델만 사용한다.
- **도구 allowlist**: 고위험 도구(`confirm.transaction`, `change.permission`, `change.member_status`,
  `delete.*`, `send.notification`, `update.budget`)는 승인 필수이며 일부는 재인증까지 요구한다.
  `change.permission`/`change.member_status`와 rollback도 역할 CAS·마지막 관리자 보호를 동일하게
  거친다. 권한 회수 뒤 rollback으로 관리자 권한을 되살릴 수 없다.
- **실행 미리보기**: 변경 도구는 before/after 미리보기 후 승인 → 실행 → `rollback_ref` 저장 순서다.
- **AI 사용량**: `/api/v1/agent/usage`. PG 회사에서는 분석 화면의 AI 사용량·audit 카드가
  `SOURCE_UNSUPPORTED`로 표시된다(원천 미지원, 장애 아님).
- **LLM Wiki 모델은 별도**: Wiki 컴파일·조사는 서버의 `WIKI_LOCAL_MODEL_CONFIG`(loopback 로컬 모델)만
  사용하고 AI 정책의 Echo/OpenRouter 설정을 상속하지 않는다. 설정은 백엔드 배포 단위가
  `.env.example`/Secret Manager에 반영하며, 이 매뉴얼은 실제 `.env` 값을 다루지 않는다. 모델이
  없으면 Wiki 작업은 "사용 불가"이고 원본 등록·게시 위키 읽기는 계속 된다.

## 5. 개인 Vault (개인 맞춤형 지식베이스)
- 각 사용자는 `/vault`(VLT-001)에 개인 노트를 두고 `[[위키링크]]`로 연결한다. 백링크와 3D 그래프
  (`/vault/graph`, VLT-002)를 제공한다.
- Vault는 **소유자 전용**이다. 같은 조직의 관리자도 조회·삭제가 404로 차단된다. PG 개인 Vault의
  소유자는 회사 선택과 무관한 인증 사용자이며, legacy Vault는 tenant/org 조건이 함께 붙는다.
- `agent_enabled`가 켜진 노트만 개인 Agent 답변의 근거로 사용된다.
- 자격증명 형태의 값(`password:`, `api_key=`, 주민등록번호 패턴)은 저장이 거부된다.
- 개인 Vault의 Wiki 원본 등록·조사·게시는 소유자만 할 수 있다. 관리자가 다른 사람의 원문을
  Wiki 입력으로 쓰거나 파생 정보를 볼 수 없다.

### 회사 문서 지식 그래프와 LLM Wiki (`/documents/graph`, DOC-004)
- 회사 문서 그래프와 개인 Vault 그래프는 같은 3D 렌더러와 legend를 쓰고 데이터 API만 다르다.
  조직도·결재 diagram은 force graph로 바꾸지 않는다. PG 프로젝트 허브 `project:<id>`는 kind
  `space`인 별도 entity이며 같은 번호의 document와 다르다.
- Wiki 권한은 회사 문서 surface(`menu.documents` + `document.read`)를 따른다. 읽기만 있으면
  조사(query)는 가능하고 원본 등록·초안(ingest/lint)·수동 편집·게시는 `document.write`가 필요하다.
  회사 관리자라도 다른 요청자의 private job/초안은 읽을 수 없다.
- 파생 문서의 권한은 페이지 scope와 **모든 입력 dependency**의 현재 권한 교집합이다. 모델이
  인용하지 않은 입력도 포함된다. 원본 삭제·권한 회수는 해당 독자에게 파생 정보를 `unavailable`
  (`SOURCE_REVOKED`)로 만들고 진행 중 job을 무효화한다.
- 게시는 사용자가 서버 digest(`manifest_hash`)를 확인한 정확한 변경 묶음에만 적용되며, 초안이
  바뀌면 이전 승인은 무효다. worker나 모델에는 게시 권한이 없다.
- 한도: job당 원문 20개/페이지 20개/edge 200개, 질문 4,000자, 출력 256KiB, scope별
  queued/running 20개. 초과는 413/422/429로 명시 거절되며 prefix만 처리한 성공은 없다.
- 유효한 인용은 추적 가능성이지 사실성 보증이 아니다. 관리자 교육 자료에서도 "검증됨"으로 쓰지
  않는다.

## 6. 감사·보존
- `/admin/audit`(ADM-002): 사용자·AI·시스템 행위의 before/after, request_id, AI 여부가 append-only
  해시체인으로 기록된다. `GET /admin/audit/verify`가 `valid=false`면 즉시 보안 인시던트다.
- 감사 로그 **검색 권한과 내보내기 권한은 분리**되어 있다(`audit.read` / `audit.export`).
- 이번 기능군의 감사 기록 범위: 역할 변경(중복 audit/알림 없음, no-op은 현재 버전일 때만 성공),
  원증빙 attach(`receipt.attached` / PG `files.receipt_events`), 결재 결정·첨부 snapshot(같은
  transaction), CSV 가져오기(hash/parser/원본 ordinal/장부 ID·건수만, 셀 값·external ID·매핑
  이름·사유·token은 저장하지 않음), Wiki event log(append-only, 본문 없음).
- `/admin/data`(ADM-004): 모듈별 보존기간, legal hold, 조직 전체 내보내기. 원증빙 원본과 Wiki 게시
  revision은 자동 삭제 정책이 없다. CSV 원본과 원증빙 임시 업로드는 24시간 뒤 만료된다(DB 시각 기준, 즉시 적용). 물리 정리는 ERP
  내장 timer가 담당하며 CSV(`ORBITFLOW_IMPORT_CLEANUP_STORES`)와 원증빙 staging
  (`ORBITFLOW_RECEIPT_CLEANUP_STORES`)을 각각 env로 켜야 동작한다. 원증빙 정리는 미소비 임시 파일만
  지우고 소비된 원본·공유 파일은 보존한다(활성화 여부와 모니터 전송은 배포 문서 참조). 이 문서는 법적 보존 요건 충족을
  주장하지 않는다.

## 7. 데이터 가져오기

### 회원·기준정보 가져오기 (`/api/v1/imports`)
1. `POST /imports/preview`: 오류 행·사유·수정 방법을 먼저 확인한다.
2. `POST /imports/commit` (`dry_run=true`): 저장 없이 검증만.
3. `POST /imports/commit` (`dry_run=false`): **오류가 1건이라도 있으면 한 건도 저장하지 않는다**.
   기존 사용자의 역할은 덮지 않는다(insert-only).

### 실지출 CSV 가져오기 (`/finance/transactions` → "CSV 지출 가져오기")
경로: legacy `/api/v1/finance/transactions/imports`, PG `/api/v1/pg/finance/transactions/imports`.

1. **업로드**: UTF-8 CSV 원본 bytes(`text/csv`), raw 5MiB, 논리 행 10,000, 열 20, 셀 4KiB. 초기 BOM만
   제거하고 RFC 4180 quoted 개행·콤마를 처리한다. 원본은 **24시간 뒤 만료**되고 새 preview를 만들어도
   연장되지 않는다.
2. **헤더 매핑**: 기본 별칭(거래ID/외부ID→external_id, 일자/날짜/사용일→expense_date,
   사용처/가맹점→merchant, 금액/지출금액→amount, 통화→currency, 계정코드/계정→account_code,
   내용/메모→memo)으로 추천하고, 사용자가 "추천을 포함한 헤더 매핑을 직접 확인했습니다."를 체크해야
   ready다. external_id/currency/memo는 선택, currency 없으면 KRW. 중복 target은 거절, 모르는 열은
   무시로 표시한다.
3. **계정 매핑**: "CSV 계정 코드와 활성 지출 계정의 정확한 매핑"을 명시한다. 이름 유사도로 계정을
   고르지 않는다.
4. **검토**: 25행 페이지로 오류·중복을 본다. 영수증 없는 행은 import 단위 "영수증 미첨부 사유"가
   필수다. 동일 identity·동일 payload는 "중복 재사용 확인"을 체크해야 재사용되고, 비슷한 날짜·금액은
   경고만 한다. "제외"는 명시 선택만 가능하며 다른 행의 번호를 바꾸지 않는다. invalid 행이 남으면
   "미리보기가 완전한 ready 상태가 아니므로 적용할 수 없습니다."
5. **적용**: "검토한 선택 행 적용"은 `POST .../:jobId/commit`에 **정확히 `{}`**와 `Idempotency-Key`만
   보낸다. 모든 전표·lines·영수증·감사·identity·결과가 한 transaction으로 commit되거나 전부
   rollback된다. 행별 부분 성공은 없다.
6. **복구**: 응답 유실 시 같은 key로 재시도하면 기존 결과, 다른 job은 409. 만료 뒤 미완료 job의
   rows/commit은 410 `IMPORT_CONTENT_EXPIRED`이며 화면은 "파일을 다시 선택해 새 검토를
   시작하세요"를 안내한다. 계정 비활성은
   `IMPORT_ACCOUNT_CHANGED`, 다른 import가 identity를 먼저 차지하면 `IMPORT_IDENTITY_CHANGED`
   409이고 새 preview가 필요하다.

- identity는 `(company, provider_source, external_id)` 또는 `(company, raw_sha256, 원본 논리 행 번호)`이며
  actor와 무관하다. 같은 값의 두 행은 서로 다른 지출로 저장된다. 파일 내용·순서·인코딩이 바뀌면
  fallback identity도 바뀌므로 cross-file fuzzy 중복 방지를 약속하지 않는다.
- `provider_source`는 파일명이 아닌 사용자가 선택한 안정된 namespace(기본 `manual_csv`)다.
- 원본 CSV는 다운로드 API·공개 로그·감사 이벤트로 내보내지 않으며 외부 AI에 전송하지 않는다.
