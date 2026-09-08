# 원증빙 소비 계약 (Task 16 -> 17/22)

## HTTP 경계

모든 경로는 `/api/v1` 아래이며 Bearer 인증과 선택 회사 `X-Org-Id`를 사용한다.

| 저장소 | 업로드 POST | 원본 GET |
| --- | --- | --- |
| legacy 거래 | `/finance/transactions/receipt-uploads` | `/finance/transactions/:id/receipts/:fileId` |
| legacy 결재 | `/approvals/receipt-uploads` | `/approvals/requests/:id/receipts/:fileId` |
| PG 거래 | `/pg/finance/transactions/receipt-uploads` | `/pg/finance/transactions/:id/receipts/:fileId` |
| PG 결재 | `/pg/approvals/receipt-uploads` | `/pg/approvals/:id/receipts/:fileId` |

본문은 JPEG/PNG/PDF bytes이며 Content-Type과 UTF-8 percent-encoded `X-Upload-Name`을 보낸다. JSON/base64/multipart, URL/path/file ID 채택은 지원하지 않는다. 응답은 `{token,filename,mime,size_bytes,checksum_sha256,expires_at}`이고 token 이외의 값을 소비 요청에 재전송하지 않는다. 검증은 malware scan, OCR 또는 PDF 실행 안전성 보장이 아니다. 원본은 attachment/nosniff/private,no-store로만 내려준다.

`services/api.ts`의 `apiBlob(path,{session,signal?})`는 `{blob,filename}`을 반환한다. 호출자는 실제 선택 저장소 경로를 사용하고, 생성한 objectURL을 사용 종료/unmount 시 revoke한다. 이 함수는 원본을 inline 렌더링하지 않으며 URL에 인증정보를 넣지 않는다. 이번 작업에는 소비 HTTP/화면을 추가하지 않았다.

## 내부 소비 API

- legacy: `consumeLegacyReceipts(principal,{kind,parentId,expectedVersion,tokens})` (`legacy-receipt-files.service.js`). 동기 함수다. 호출자의 같은 SQLite 동기 transaction 안에서만 호출한다. `BEGIN IMMEDIATE`를 권장한다. Promise를 SQLite transaction callback에서 반환하지 않는다.
- PG: `await consumePgReceipts(client,principal,{kind,parentId,expectedVersion,tokens})` (`pg-receipt-files.service.js`). `client`는 반드시 호출자의 이미 BEGIN된 전용 client이며 pool/autocommit을 전달하지 않는다. 전표/lines/도메인 변경/audit/replay와 함께 단 한 번 COMMIT하고, 어느 단계의 오류든 전체 ROLLBACK한다.
- `principal`은 인증 경계에서 해결한 실제 actor/company이다. 본문으로 구성하지 않는다. `kind`는 서버가 고정한 `transaction|approval`이다. 동일 저장소/회사/actor/kind에 속하고 미소비/미만료인 token만 허용한다.
- PG lock 순서는 회사 `org.companies FOR UPDATE` -> 현재 membership/grants/module/feature -> parent `FOR UPDATE` -> ID 정렬된 staging `FOR UPDATE`이다. 후속 domain writer도 회사 lock을 먼저 잡아 같은 순서를 지킨다. SQLite에서는 같은 동기 write transaction을 사용한다.
- `expectedVersion`은 소비 시점의 실제 부모 버전이다. legacy는 `parent.version`, PG는 같은 client에서 조회한 `xmin::text`이다. 외부 요청의 stale 검증은 도메인 write 전에 별도로 수행한다. 부모를 같은 transaction에서 생성/수정했다면 그 뒤 실제 버전을 읽어 전달한다. 기본 1 또는 추정 xmin을 합성하지 않는다.
- 현재 권한은 stale version보다 먼저 검사한다. 결재 첨부 쓰기는 requester의 draft 또는 기존 즉시제출 호환 pending에만 허용한다. 전용 workflow가 submit 때 `workflow_locked`와 attachment snapshot을 저장한 pending은 더 이상 추가·교체·삭제할 수 없고 종결 원본도 변경하지 않는다. legacy 다운로드는 requester/실제 배정된 reader, PG는 requester 또는 기존 authorized-decider pool에 한정한다. 회사 관리자를 이유로 legacy 비공개 경계를 우회하지 않는다.
- 반환값은 `{file_id,filename,mime,size_bytes,checksum_sha256}[]`이다. 순서에 의존하지 않는다. 5개/25MiB는 기존 link와 이번 token을 합쳐 검사한다. legacy의 과거 `transaction_evidence.org_id IS NULL`도 이미 인가된 부모와 동일 tenant/company의 `file_object`에 연결된 경우 합산한다. 외부 tenant/company 파일이나 명시적으로 다른 회사에 속한 link는 채택하지 않으며 NULL 소유권을 backfill하지 않는다. 같은 token 재소비는404이며 caller의 인가된 idempotency replay는 소비 함수를 다시 호출하기 전에 처리한다.
- 소비는 검증된 staging metadata에서만 `file_object`/`files.objects`를 만들고 부모 link와 `receipt.attached` audit 또는 PG `files.receipt_events`를 함께 기록한다. PG storage bucket은 `orbitflow-local`, key는 생성된 `receipts/<uuid>.<ext>`이다.
- 원본/link update/delete는 DB trigger가 거부한다. PG journal link는 `accounting.journal_entry_files`, 결재는 `org.approval_request_files`; legacy는 확장된 `transaction_evidence`와 `approval_receipt_files`이다. 과거 다른 파일은 변환하거나 삭제하지 않는다.

## 정리와 마이그레이션

`cleanupLegacyReceipts()` (동기)와 `await cleanupPgReceipts()`는 자체 transaction을 소유한다. 도메인 transaction 안에 중첩 호출하지 않는다. 자동 scheduler/운영 실행은 설치하지 않았다. 선택 저장소의 만료된 `writing|ready` staging만 처리한다. 소비와 동일한 write/row lock을 사용하며 PG는 SKIP LOCKED이다. `{deleted,failed,shared}`를 반환하고 unlink 실패 또는 공유 경로 보존 사유를 `cleanup_error`에 남긴다. 다음 명시 호출로 재시도할 수 있다. consumed 원본과 기존 공유 object는 sweep하지 않는다. 보존기간 법적 충족을 주장하지 않는다.

PG additive DDL은 `db/perp_additions_v12_deadline_expenses.sql`이다. nullable counterparty/occurred_at/input_currency/no_receipt_reason은 후속 입력용이며 과거 null을 추측하지 않는다. 현재 통합 baseline에서는 역할 CAS migration9 다음 번호인 migration10에 등록했고, 같은 `up` callback이 원증빙 직후 비용 replay/불변 guard를 적용한다. 공유 router/API helper/lockfile 병합 순서는 이 통합 결과를 따른다.

## 수정된 보안 핀과 실제 검증

Contract E 승인에 따라 `file-type@21.3.2`, `sharp@0.35.0`, `pdf-lib@1.17.1`을 workspace/lockfile에 정확히 고정했다. GitHub 공식 advisory 기준 file-type은 GHSA-5v7r-6r5c-r473 (`>=13.0.0 <21.3.1`) 및 GHSA-j47w-4g3g-c36v (`>=20.0.0 <=21.3.1`), sharp는 GHSA-f88m-g3jw-g9cj (`<0.35.0`)의 영향 범위를 벗어난다. 2026-09-08 fresh `npm audit --json`은 전체 workspace에서 0건을 보고했다. 이는 이후 새 advisory나 독립 검증을 대체하지 않는다.

sharp0.35.0의 Node 요구 조건은 `>=20.9.0`이며 기존 backend의 `>=22.5.0`과 양립한다. 실제 Node24.18.0/Windows x64에서 `sharp.versions.vips=8.18.3`을 확인했다. 사용 중인 constructor 옵션(`limitInputPixels`, `failOn`, `animated`), `metadata()`, `raw().toBuffer()`는 실제 HTTP의 40M 허용/초과 거부 및 metadata는 유효한 손상 JPEG의 전체 decode 거부로 검증했다. JPEG/PNG/PDF 원본 checksum, encrypted PDF 거부, native PG transaction 및 Chrome apiBlob 검증도 다시 통과했다. 이전 실패 증거는 보존하고 새 결과/실행 명령은 `.omo/evidence/task-16-revision/`에 별도 기록한다.

## Third-party license / NOTICE 보존

| 패키지 | 라이선스 / 저작권 | 설치본에서 보존할 원문 |
| --- | --- | --- |
| file-type21.3.2 | MIT; Copyright (c) Sindre Sorhus | `node_modules/file-type/license` |
| pdf-lib1.17.1 | MIT; Copyright (c) 2019 Andrew Dillon | `node_modules/pdf-lib/LICENSE.md` |
| sharp0.35.0 | Apache-2.0; Copyright 2013 Lovell Fuller and others | `node_modules/sharp/LICENSE`, `README.md` |
| @img/sharp-win32-x64 0.35.0 | Apache-2.0 AND LGPL-3.0-or-later; Copyright 2013 Lovell Fuller and others | `node_modules/@img/sharp-win32-x64/LICENSE`, `README.md`, `versions.json` |

Windows binary를 sharp JS 패키지의 Apache-2.0만으로 표시하지 않는다. 다음은 해당 binary README의 third-party NOTICE 정보이며 실제 원문은 위 경로와 revision evidence의 `licenses/`에 SHA-256과 함께 그대로 보존했다. upstream은 별도 `NOTICE` 파일 대신 README에 이 정보를 제공한다.

| 라이브러리 | upstream 사용 라이선스 |
| --- | --- |
| aom | BSD 2-Clause + [Alliance for Open Media Patent License 1.0](https://aomedia.org/license/patent-license/) |
| cairo | MPL-2.0 |
| cgif, expat, harfbuzz, lcms, libffi, libnsgif, libultrahdr, libxml2, pixman | MIT |
| fontconfig | [fontconfig License](https://gitlab.freedesktop.org/fontconfig/fontconfig/blob/main/COPYING) (BSD-like) |
| freetype | [freetype License](https://git.savannah.gnu.org/cgit/freetype/freetype2.git/tree/docs/FTL.TXT) (BSD-like) |
| fribidi, glib, libexif, libheif, librsvg, libvips, pango, proxy-libintl | LGPLv3 (LGPLv2/v2.1의 any-later-version 조항 사용) |
| highway | BSD 3-Clause |
| libarchive | BSD 2-Clause |
| libimagequant | [BSD 2-Clause](https://github.com/lovell/libimagequant/blob/main/COPYRIGHT) |
| libpng | [libpng License](https://github.com/pnggroup/libpng/blob/master/LICENSE) |
| libtiff | [libtiff License](https://gitlab.com/libtiff/libtiff/blob/master/LICENSE.md) (BSD-like) |
| libwebp | New BSD License |
| mozjpeg | [zlib License, IJG License, BSD 3-Clause](https://github.com/mozilla/mozjpeg/blob/master/LICENSE.md) |
| zlib-ng | [zlib License](https://github.com/zlib-ng/zlib-ng/blob/develop/LICENSE.md) |

재배포 시 설치본의 license/저작권/NOTICE와 LGPL 해당 소스 제공 및 교체 가능성 의무를 보존해야 한다. native build의 upstream은 https://github.com/lovell/sharp-libvips 이다. 이 기록은 실제 배포나 법적 충족 인증이 아니다.
