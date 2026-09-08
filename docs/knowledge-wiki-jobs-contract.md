# Wiki 작업 운영/소비자 계약 (Task32)

기반: `64e00f29bb1a1cd948f2c2903c642719e8c9a88f`, Task31 frozen consumer revision2. 추가 migration 없음. Task33 파일을 가져오거나 게시 기능을 구현하지 않는다.

## HTTP

기존 인증 parent의 `/vault/wiki`, `/documents/wiki`, `/pg/vault/wiki`, `/pg/documents/wiki` 아래에 다음 경로를 추가한다. 응답은 private/no-store/nosniff이다. scope/actor는 parent에서만 정한다. 회사 관리자도 다른 요청자의 private 작업을 읽거나 claim하지 못한다.

Company query admission, replay, claim, heartbeat, acceptance, retry and cancel require current `menu.documents` + `document.read` and source access, not `document.write`. Ingest/lint also require `document.write`; exact query-to-draft requires current read AND write in one locked SQL transaction, before reading the result or returning an existing draft. Source registration/recapture/withdrawal, manual page mutation and publication receive no authority from research. Removing only write authority during query inference does not invalidate its result. Personal scope retains its existing actor/Agent authorization.

- `POST /jobs`, 필수 `Idempotency-Key` (공백 없는 ASCII 1..200). 새 접수202, 동일 요청 replay200, 다른 request hash409.
- ingest body: `{operation:"ingest",source_revision_ids:string[],target_base_versions?:[{page_id,version,published_head_id}]}`. ID 중복 불가; source20/target20.
- query body: `{operation:"query",question,retrieval:{raw,published_wiki,source_revision_ids?:string[]}}`. 질문4000자, 검색 대상 하나 이상. raw-only 및 published page0개 지원. coverage는 선택한 revision ID뿐 아니라 전체 선택 span DTO의 `selected_spans`도 보존한다.
- lint body: `{operation:"lint",page_revision_ids:string[]}` (현재 게시 revision20개 이하).
- `GET /jobs/:id`: `{id,operation,state,fence,current_attempt_id,failure_code,result,input_manifest_hash,created_at,updated_at,attempts}`. 원 요청자의 현재 입력 권한/최신성을 재검사한다. stale/revoked 입력은 본문을 반환하지 않고409, 다른 actor/scope는404, 현재 surface/action 권한 실패는403.
- `POST /jobs/:id/retry`, `POST /jobs/:id/cancel`, `POST /jobs/:id/draft`: 엄격한 빈 JSON body `{}`.
- retry는 failed/unavailable만 queued로 바꾼다. 이미 queued이면 동일 상태를 반환한다. 성공 결과는 덮지 않는다. 전체 입력과 target vector가 여전히 유효해야 하며 최대3 attempts다. 원본 변경은 새 job을 요구한다.
- cancel은 queued/running을 `failed`, `failure_code:"CANCELLED"`로 만들고 fence를 올린다. 동일 cancel replay는 멱등이다. 취소는 입력/결과를 공개하지 않으므로 stale 입력도 queue에서 취소할 수 있다. 모델 취소/롤백 또는 정확히 한 번 inference를 보장하지 않으며 늦은 acceptance/heartbeat는 거부한다.
- query draft 응답: `{change_set_id,manifest_hash,result_revision_id}`. 성공한 cited result당 한 묶음만 생성한다. 원래 `job.result_json`/hash는 변경하지 않는다. draft Markdown과 `provenance.exact_result`는 정확한 성공 결과를 고정한다. no-evidence/unavailable은 draft를 만들 수 없다.

`job.result_json`은 공유 interface의 `{result_revision_id,operation,review_state:"unreviewed",answer_md,citations,citation_validation,freshness,input_manifest_hash,provenance,uncertainty,retrieval_coverage,change_set_id,issues}`이다. 결과 provenance의 `anchor_meaning:"traceability_not_verified_truth"`는 유효 인용이 사실성/논리적 뒷받침의 검증이 아님을 나타낸다. 결과에 없는 값은 null/빈 배열이다. 근거 없는 query는 모델 호출 없이 성공한 `no_evidence`, `answer_md:null`이며 모델 부재와 구분된다.

Lint는 빈 Markdown/title/index 및 잘못된 citation/link JSON 배열을 `kind:"structural"`로, 모델 제안을 `kind:"model_suggestion"`으로 구분한다. 전면적인 사실 검증이나 모든 Markdown 문법 검사를 주장하지 않는다. 수정 제안은 초안일 뿐 기존 head를 바꾸지 않는다.

## Worker / strict local provider

`backend/src/services/knowledge-wiki-jobs.service.js`의 공개 service 함수는 두 DB에서 모두 Promise를 반환한다:

```js
admitWikiJob(context, request, idempotencyKey, configuration = null)
getWikiJob(context, jobId)
claimWikiJob(context, jobId, owner, modelSnapshot) // lease 또는 null
heartbeatWikiJob(context, jobId, lease)
acceptWikiResult(context, jobId, lease, envelope)
failWikiJob(context, jobId, lease, code, status)
retryWikiJob(context, jobId)
cancelWikiJob(context, jobId)
draftWikiQuery(context, jobId)
runWikiJob(context, jobId, {signal, owner} = {})
// lease: {job_id, owner, fence, attempt_id}
```

`context`는 frozen Task31 `wikiContext`로 만든 내부 인증 DTO다. claim/accept/heartbeat는 HTTP capability가 아니다. 내부 worker만 compiler의 검사된 model snapshot/envelope를 전달한다. API에 임의 manifest/model output/SQL을 받는 경로는 없다.

`knowledge-wiki-worker.service.js`의 `startWikiWorker({stores:['legacy','pg'],onError})`는 `{wake,stop}`을 반환한다. `server.js`가 startup에 시작하고 종료 시 `await stop()`한다. private 정적 header 조회만 Wiki scope/actor/job ID를 발견하며 입력/제목/result는 조회하지 않는다. 본문/config를 worker에 넘기기 전 trusted job bookkeeping transaction이 현재 actor/저장된 operation의 권한을 재인가한다. SQL write mode는 원자성/잠금이고 document mutation 권한이 아니다. 최초 실행 및30초 maintenance, `orbitflow:wiki-job-queued` 신호에서 durable queue를 처리한다. 단일 scheduler는 직렬 실행하며 Wiki lock이 복수 scheduler/process claim을 직렬화한다.

정책: scope당 queued/running20; lease120초; heartbeat30초; attempt3. claim/reclaim은 새 attempt/fence를 만든다. DB clock만 lease 판정/연장에 사용한다. 만료 worker의 자기 lease 부활은 불가하다. model/validation failure는 자동 retry하지 않는다. queued/만료 작업의 stale 입력은 인가된 maintenance가 fence를 올려 실패 처리한다. actor/read/operation 권한이 사라진 작업은 읽거나 dispatch하지 않는다. 현재 권한 거부를 독립적으로 재검사하는 fixed metadata-only retirement가 실패 상태, attempt 종료, fence 증가, lease 제거, event만 원자적으로 쓴다. 입력/config/result를 조회하거나 반환하지 않는다. 실행 owner는 정확한 유효 lease를 제시해야 하며, scheduler는 queued/이미 만료된 running만 정리한다. 살아 있는 다른 lease는 건드리지 않는다.

입력/source/target/schema/config는 admission에 고정한다. 매 attempt에서 전체 manifest와 provenance를 immutable `job_input.input_json`에 저장하고 commit한 뒤, 다시 현재 권한/lease/전체 manifest를 검사한 후 model HTTP를 호출한다. inference 동안 DB transaction을 유지하지 않는다. acceptance는 fresh authority/dependency/target/fence/DB시간 검사와 draft/dependencies/result/attempt/event/state를 하나의 transaction으로 쓴다. 검증 후에도 DB시간을 다시 검사한다. source/target 변경 결과는409로 거부하며 사용자 head를 덮지 않는다.

명시적 서버 설정만 사용한다. 범용 AI provider/Echo 및 private 환경변수의 자동 상속은 없다:

```text
WIKI_LOCAL_MODEL_CONFIG={"base_url":"http://127.0.0.1:12345","model":"loaded-identifier","context_tokens":8192,"output_tokens":1024,"timeout_ms":120000,"temperature":0}
```

이 변수는 예시이며 `.env`를 생성/변경하지 않는다. 설정은 엄격한 allowlist로 검증한다. 비밀/API key 필드는 받거나 기록하지 않는다. URL은 HTTP numeric loopback (`127.0.0.1` 또는 `[::1]`) origin만 허용하며 DNS/userinfo/path/query/hash/외부/redirect는 거부한다. 요청 경로는 고정된 `/api/v0/models`와 `/v1/chat/completions`뿐이다. private `node:http` connection (`agent:false`)을 사용하여 ambient fetch/proxy dispatcher를 상속하지 않는다. 현재 adapter는 LM Studio-compatible loaded metadata (`state:"loaded"`, 실제 `loaded_context_length`, 정확한 `id`)도 필수다. 단순 `/v1`만 있는 임의 provider를 지원한다고 주장하지 않는다.

응답 envelope 전체256KiB, JSON 구조/page20/edge200 및 서버 변환 후 출력 크기를 검사한다. tool/function call은 거부하고 빈 `tool_calls:[]`는 실행 요청이 없는 정상 wire shape로 허용한다. 도구/file/URL-fetch capability는 없다. 모델의 정수 citation index는 저장된 server anchor에만 매핑한 뒤 transaction에서 원문 hash/span/현재 권한을 검증한다. trusted compiler/schema/operation 지시는 system 입력에, 원문/catalog/질문은 user 입력에 별도로 저장/전달한다.

context accounting은 tokenizer라고 주장하지 않는 보수적 `UTF-8 request bytes + 512 framing` 상한 추정과 output reserve를 합산한다. 초과422이며 prefix 절단이 없다. 실제 loaded model ID/context/architecture/quantization/config와 provider 보고 prompt/completion token도 기록한다. 모델 광고 max context를 실제 loaded context로 쓰지 않는다.

## Backward-compatible storage extension / Task33 coordination

`knowledge-wiki-store.service.js` keeps `withKnowledgeTransaction(context, {write = false}, work)` and its frozen scoped facade unchanged for existing consumers. Read transactions still enforce SQLite query_only / PostgreSQL READ ONLY, reject raw SQL tokens and expire the facade. Ordinary `{write:true}` still requires document mutation authority. No `authorization`, `bookkeeping`, or other client-selectable option changes that behavior. No migration or schema/manifest/lease/DTO change.

Three additive, server-only exports are used by the jobs service:

```js
withKnowledgeJobTransaction(context, {operation: 'query' | 'ingest' | 'lint'}, generator) // admission only
withKnowledgeJobTransaction(context, {jobId: string}, generator) // stored actor/operation authority
retireUnauthorizedWikiJob(context, jobId, lease = null) // boolean (SQLite) / Promise<boolean> (PG)
withKnowledgeQueryDraftTransaction(context, generator) // current read AND write, same SQL transaction
```

The selectors are exclusive. The first export has the existing generator/SQLite synchronous/PG Promise transaction protocol, always SQL-write/locked but independently authorized. Query bookkeeping is restricted to that actor's selected/new job, its attempts, immutable inputs, job dependencies and job events. Only write-authorized ingest/lint can create draft change sets and their dependencies in this facade. Job operation/actor/request cannot be patched. It cannot register/recapture/withdraw sources, update Wiki metadata, mutate page/page_revision or insert publication receipts. The original facade gains no methods or bypass. Job services continue to return Promises on both engines.

Retirement exposes no callback, SQL or result-bearing facade. It derives denial itself (`PERMISSION_DENIED` / `MODULE_DISABLED`), scopes to the exact Wiki + actor + job, and returns only whether metadata was retired. A supplied lease must match owner/fence/attempt and remain live; without one only queued/expired jobs qualify. Authorized actors, wrong owners, foreign scopes, stale leases and terminal jobs cannot use it to retire a live authorized/replacement job. Unexpected storage errors still propagate.

`withKnowledgeQueryDraftTransaction` uses the ordinary write facade, not the restricted job-bookkeeping facade. It first authorizes current read, then opens with current write authorization, on the same SQLite immediate transaction / PG client with the same company/account/membership locks. Only then can the owning jobs-service callback inspect the actor-owned result, revalidate complete lineage, create a draft or return a prior draft. Both new conversion and idempotent replay require both permissions. It preserves the original generator and synchronous SQLite / Promise PG protocol; it exposes no selectable permission option and does not change the original write contract or permit reader bookkeeping to create drafts.

Task33 must retain its original `{write:true}` contract for manual edit, review, draft mutation and explicit publication, plus its fresh lineage/digest/head gates. Do not import the job capability into a general HTTP transaction facade. Preserve the jobs-router mount and server worker lifecycle. The Task33 worktree is not edited by this revision.

## Task33 소비 경계

성공 ingest/lint는 `change_set` 하나 또는 no-change null을 만들며 page/page_revision/publication을 쓰지 않는다. query 저장도 초안만 만든다. SQL JSON은 모두 `canonical(...)` TEXT다.

`job.source_vector_json`은 `{manifest,coverage,targets,issues,anchors,configuration}` admission snapshot이고, `target_vector_json`은 expected existing heads 배열이다. `config_version`은 `sha256(canonical(configuration))`이다. `job_attempt.config_json`은 `{model_version,configuration,loaded_context_tokens?,architecture?,quantization?,context_verification,accounting}`이며 unavailable/no-evidence에서는 실제 dispatch하지 않았음을 표시하고 loaded metadata를 합성하지 않는다. model envelope는 `{output,model_version,accounting}`이고 `output`은 compiler module의 strict schema를 통과해야 한다.

- proposed revisions: `{page_id,kind,title,markdown,index_entry,citations,links,provenance}[]`. 새 page/link ID는 서버 UUID, 기존 page kind는 유지한다.
- expected heads: `{page_id,version,published_head_id}[]`; 새 page의 version/head는 null.
- lineage는 인용 subset이 아닌 완전한 `{inputs,hash}`. 모든 source/raw closure와 직접 page dependency를 `dependent_change_set_id`로 보존한다.
- `manifest_hash = sha256(canonical({wiki_id,actor_id,job_id,proposed_revisions,expected_heads,lineage,schema_revision_id,input_manifest_hash}))`.
- Frozen nonblank title bytes are preserved through publication decoding. Acceptance enforces the aggregate 200-edge budget as page citations plus links, not links alone.
- With integrated SQLite14/PGv18, source invalidation proactively sets `unavailable` / `SOURCE_REVOKED` and clears leases; an in-flight completion then fails `LEASE_LOST`. Current lineage checks still deny result/retry. Authority changes wake reauthorization rather than blindly invalidating reader jobs; actual denial uses the restricted metadata retirement contract above.
- compiler link: `{id,type:"ai_derived",target_page_id,predicate,direction,origin:"compiler",citations}`. bundle page 또는 context에 공급된 인가된 기존 page만 target이다. parallel edge/방향을 합치지 않는다.
- Task33는 자신의 scoped transaction에서 read/review/publish/reject 및 모든 현재 권한/digest/expected-head 검사와 immutable publication receipt를 소유한다. 작업 결과가 `unreviewed`이고 anchor가 유효하다는 것은 게시 승인이 아니다.

공유 route 통합 delta는 `knowledge-wiki.routes.js`의 jobs router import와 `router.use('/jobs',knowledgeWikiJobsRouter(store,scope,context))`뿐이다. Task33 route를 같은 파일에 통합할 때 이 mount를 보존한다.

## 검증 실행

```sh
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node --test backend/tests/deadline-wiki-jobs.test.js backend/tests/deadline-wiki-jobs-native.integration.mjs backend/tests/deadline-wiki-reader.test.js backend/tests/deadline-wiki-reader-native.integration.mjs
node scripts/run_deadline_isolated.mjs node backend/tests/deadline-wiki-model-smoke.mjs '{"base_url":"http://127.0.0.1:12345","model":"perp-task32-smoke","context_tokens":8192,"output_tokens":1024,"timeout_ms":240000,"temperature":0}'
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node backend/tests/deadline-wiki-runtime-smoke.mjs
node scripts/run_deadline_isolated.mjs npm run build
```

실제 모델 smoke는 unoccupied 확인 후 이미 로컬에 있는 Gemma4 Q4_K_M을 `perp-task32-smoke`, 실제8192 context로 load하고 소유한 loopback12345 서버에서만 실행했다. 한국어 합성 원문 ingest/query, exact query draft, 게시0, 원문 불변을 확인했다. 사용한 서버만 stop하고 해당 named model만 unload했다. `.omo/evidence/task-32-deadline-erp-redesign/`에 RED/GREEN, wire/provenance, 경합, 정리와 DoneClaim을 보존한다. 합성 protocol fixture와 lint publication storage fixture를 실제 inference/Task33 게시 검증으로 혼동하지 않는다.
