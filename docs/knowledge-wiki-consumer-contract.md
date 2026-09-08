# Wiki storage consumer contract v1 (Task 31)

Status: frozen revision 2 for independent verification after dual-engine regression and HTTP/native smoke passed. This supersedes the pre-review raw-SQL consumer interface; the v1 DTO and SQLite12/PGv15 allocations are unchanged. Task 32 inference/leases and Task 33 publication are not implemented here. No jobs are created by HTTP source registration or retrieval. Test-created job/page/publication rows are explicitly storage fixtures, not inference or publication workflow evidence.

## Ownership and migration

- SQLite migration **12**, allowing explicit gaps 10/11; `applyMigrations` checks the applied version set. PostgreSQL additive deployment file **`db/perp_additions_v15_knowledge_wiki.sql`**. Apply that file once, in one migration transaction, after the verified base's schema/role migrations. No operating DB was migrated. These allocations remain reserved; this unshipped revision adds mandatory `job_input.input_json` within SQLite12/PGv15. Old disposable Task31 databases must be recreated; no provenance backfill can recover discarded fields.
- `backend/src/config/knowledge-schema.js`: authoritative `knowledgeDDL('sqlite'|'pg')`, `KNOWLEDGE_TABLES`. The shipped PG SQL equals the generated PG DDL, checked by a test. PG tables use `knowledge.*`; SQLite uses `knowledge_*`. IDs are opaque TEXT UUIDs, not origin numeric IDs.
- Canonical Markdown is `page_revision.markdown`, immutable in both engines. There are no filesystem Wiki copies and no conversion of original notes/documents. `index_entry` is an immutable authorized projection input, not a separate mutable index file.
- Tables: wiki, schema_revision, source, source_revision, page, page_revision, job, job_attempt, job_input, dependency, change_set, publication, event. The migration is the complete column/type/default contract. JSON fields are canonical JSON TEXT in both engines (not pg driver JSON objects).
- Composite FKs always include wiki ID. Source/page heads additionally reference their own parent ID. Wiki scope uniqueness handles nullable company/personal identities. Record source uniqueness is `(wiki_id,origin_kind,origin_id)`, including withdrawn registrations. Upload identity is a generated source ID; filename/hash are not identity.
- Revision/input/dependency/publication/event rows reject UPDATE and DELETE. Wiki/source/page/job/attempt/change-set identity or snapshot fields reject changes; DELETE is prohibited. Change-set state, page head/version/state, and job/attempt operational fields remain writable for their owning workers. Workers must enforce terminal transitions, CAS and fencing; generic transaction methods do not implement those workflows.
- Task 32 owns `knowledge-wiki-jobs.service.js`, strict local compiler, worker lifecycle, result validation/acceptance, private job authorization, actual dispatch completeness and `/jobs` routes. Task 33 owns publication/change-set actions, source mutation invalidation integration, authorized graph/history/replay/event-stream semantics. Coordinate route additions rather than modifying source routes in parallel.

## Authenticated scope

Import from `backend/src/services/knowledge-wiki-store.service.js`:

```js
wikiContext({store, scope, actorId, tenantId = null, companyId = null})
// frozen {store:'legacy'|'pg',scope:'personal'|'company',actorId,tenantId,companyId,ownerId}
```

Construct only from a trusted authenticated parent or a persisted job's authenticated actor/scope. Never spread a request body into this call. PG personal ignores selected company and has null tenant/company. Legacy personal includes tenant, organization and authenticated owner. Company owner is null. Original record kinds are `note` under personal and `document` under company; cross-parent capture is denied.

Every transaction freshly checks active account, active membership/company/tenant where applicable, existing surface/action permission and module state. It does not trust permissions in a saved context object. PG personal is owner-only and does not acquire company membership/permission authority. HTTP's PG parent still validates a supplied selected-company header using existing behavior.

## Stable transaction API

```js
withKnowledgeTransaction(context, {write = false} = {}, function* (tx) {
  const rows = yield* tx.all('source');
  return rows;
}) // SQLite: synchronous result; PG: Promise<result>; await works for either
registerSource(context, input) // same dual return convention; internal validated registration input
retrieveKnowledge(context, {question, retrieval}) // same dual return convention
```

Callbacks **must be synchronous generators**, not ordinary/async functions or async generators; other callback shapes are rejected before invocation with `ASYNC_TRANSACTION_CALLBACK`. All database operations use `yield*`. Yielded thenables and final thenable results also fail with that code **before COMMIT**, on both engines, regardless of eventual resolution/rejection. Native Promise rejections are observed as the protocol error's `cause`; custom thenables are never assimilated. The facade and suspended operations expire on completion/failure (`TRANSACTION_EXPIRED`), before commit/rollback; they cannot be reused by late continuations or another transaction. Only opaque, single-use operations issued by that exact transaction can execute; yielding hand-built SQL fails `INVALID_TRANSACTION_OPERATION`.

SQLite writes run synchronously inside `BEGIN IMMEDIATE`/COMMIT. Reads run with connection `PRAGMA query_only=ON` and `BEGIN`; the prior query-only setting is restored on every exit. PG uses one native client/transaction; reads use `REPEATABLE READ, READ ONLY`, enforced by PostgreSQL itself, without write locks. Exceptions roll back all writes, including deferred FK failures at commit. Nested transactions, inference, network calls and using another DB connection inside a callback are forbidden. This is an internal consumer API, not a JavaScript sandbox for code that imports unrelated database capabilities.

Write lock order: company row (PG company scope, same `FOR UPDATE` row used by role mutations), current actor/account/membership validation, Wiki row, then job/source/page and origin rows. PG personal serializes existing Wiki writes on its Wiki row; concurrent first registration is resolved by scope uniqueness plus conflict/reselect. Source reads inside **write transactions** acquire `FOR SHARE` on actual origin and parent rows, preventing revision changes/deletion until transaction completion. Read-only PG authority, origin and dependency checks use one consistent fresh transaction snapshot, their linearization point; a transaction started after revocation sees the revocation. SQLite's synchronous snapshot cannot yield to an HTTP mutation.

Locking/fresh validation is the transaction's linearization point. Result acceptance and publication must re-open a **write** transaction, lock the job (`get(...,true)`), check actor, lease owner, fence, running state and unexpired DB time, revalidate the full manifest/dependencies, then atomically write all outputs/dependencies/heads/events/state. Task 32 must commit dispatch inputs **before** inference and must not keep a transaction open during inference. Task 33 must check manifest digest/source vector/target CAS and idempotency replay inside this boundary, including replay authorization. Neither workflow is supplied by Task 31's generic insert/update methods.

`tx` is a frozen facade. `tx.context` and the returned `tx.wiki` snapshot are immutable; `tx.pg` is informational. Wiki is null on an untouched read-only Wiki. SQL, mutable authority/scope state, `open`, `authorize`, and `capture` are **not exposed**. `rows` and `one` have been removed, not relabeled as scoped SQL. Public generator methods:

| Signature | Result / requirement |
| --- | --- |
| `clock()` | DB-clock UTC ISO instant, millisecond precision; use for lease comparisons, not application wall time. |
| `get(table, id, lock = false)` | Wiki-scoped row/null; `lock:true` requires write mode and uses PG `FOR UPDATE`. Raw storage row, **not** a reader-authorization API. |
| `all(table, {where = {}, orderBy = ['id'], limit} = {})` | Wiki-scoped raw rows. `where` is a map of column names to equality values (`null` means IS NULL); all predicates are ANDed with the private Wiki predicate. `orderBy` is an array of ascending column names; optional limit is a positive safe integer. No SQL suffixes, expressions, directions, or callbacks. Identifiers are validated and quoted; values are bound. |
| `insert(table, record)` | Write-only; supplies wiki_id/id if absent; rejects foreign wiki. Returns inserted input fields. DB defaults not supplied in input require `get` to read back. |
| `update(table, id, patch)` | Write-only; Wiki-scoped update, then returns stored row/null. Identity changes are forbidden. CAS/fence predicates belong to the owning worker using locked rows, never raw SQL. |
| `updateWiki({generation?, active_schema_id?})` | Write-only; nonempty patch limited to these two fields on the current locked Wiki, returns updated snapshot. Generic get/all/insert/update deliberately reject table `wiki`. |
| `event(kind, references = {}, metadata = {})` | Append monotonic per-Wiki sequence under Wiki lock. References may contain source_revision_id/page_revision_id/job_id/change_set_id. Only trusted metadata; no hidden titles or bodies. |
| `origin(kind, id)` | Currently authorized origin snapshot/null; original version token is string-normalized, never synthesized for uploads. |
| `register(input)` | Source plus `created`; record replay returns same current registration. Withdrawn identity returns 409, not a silently new identity. |
| `recapture(sourceId, input)` | CAS source snapshot/new immutable revision. Record version must be exact current origin version. |
| `withdraw(sourceId, expectedVersion)` | CAS registration tombstone only; original record untouched. |
| `sources({cursor = '',limit = 50} = {})` | Authorized cursor items; limit 1..100, `next_cursor` from authorized IDs only. |
| `sourceRevision(id, {current = false} = {})` | Exact immutable revision + source/extraction identity + freshness, or null. Intersects capture-time restrictions with current origin access/deletion. `current:true` also rejects stale. |
| `pageRevision(id, {current = true} = {})` | Authorized published revision/null, requires a publication receipt containing this revision; recursively checks every dependency. `current:false` permits explicitly labeled stale historical bodies only when all current access checks pass. |
| `pages()` | Current authorized published revisions; never draft pages or stale heads. |
| `retrieve({question,retrieval})` | See retrieval DTO below. |
| `rawClosure(kind,id)` | Current authorized transitive raw revision IDs for source/page revision; fails closed on inaccessible/stale/cyclic dependency. |
| `manifest(inputs)` | Freshly authorized, recursively frozen complete ordered manifest; see below. |
| `persistInputs(jobId,attemptId,manifest)` | Writes each complete canonical input to mandatory immutable `job_input.input_json` plus searchable/FK columns and full raw/page job dependencies. Requires matching attempt's manifest hash; revalidates manifest. Call once per attempt before dispatch; duplicates fail, never overwrite. Caller owns fencing/state/lease checks. |
| `storedManifest(jobId,attemptId)` | Reconstructs the exact frozen ordered `{inputs,hash}` from durable input_json ordered by ordinal; requires matching scoped attempt/job/hash or fails MANIFEST_CONFLICT. Raw storage reconstruction, **not** current authorization: revalidate using `manifest(saved.inputs)` before dispatch/acceptance/publication. |
| `validateCitation(citation,manifest)` | Validates manifest membership, current authority/revision/hash/UTF-8 boundaries; returns `{citation,quote,source_identity,extraction_revision_id}`. |

Task 32/33 successor signatures: use `yield* tx.all('job',{where:{state:'running'},orderBy:['created_at','id']})` for scoped candidate discovery, `yield* tx.get('job',jobId,true)` followed by locked state/actor/lease-owner/fence/`yield* tx.clock()` checks and `yield* tx.update('job',jobId,patch)` for claim/reclaim/heartbeat/result CAS. The Wiki write lock (SQLite immediate transaction) serializes these predicates and writes; no raw conditional SQL or SKIP LOCKED capability is exposed. Workers may serialize per Wiki initially. Task32 owns authenticated scope discovery and all terminal/expiry transitions; this API does not grant global job enumeration. Task33 uses the same locked get/check/update for page heads and `updateWiki` for generation/schema, with inserts for immutable outputs/receipts/dependencies/events. Keep model/network work outside the callback. `insert`/`update` are internal scoped storage primitives, not permission to return private job/draft rows directly to HTTP; owning services must enforce actor and full input authorization.

Task 33 publication receipts must store **`result_json: {page_revision_ids: string[], ...}`**. Read APIs use this machine-consumed list to distinguish published history from draft revisions; a populated page head alone does not publish a revision. Every output must inherit **all** input dependencies, not just citations. Add direct page dependencies plus transitive raw closure to `dependency` with `dependent_page_revision_id`; the source/page reference columns are mutually exclusive. Use `dependent_change_set_id` for draft lineage and `dependent_job_id` for job lineage. This is an obligation of workers, not automatic inference from prose.

## Frozen DTO / manifest / citations

Import `WIKI_CONTRACT`, `sourceRegistrationSchema`, `recaptureSchema`, `sourceCasSchema`, `citationSchema`, `canonical`, `sha256`, `freezeManifest`, `citationFor`, `restoreSpan`, `rankAuthorized` from `knowledge-wiki-contract.service.js`.

- `WIKI_CONTRACT` is recursively frozen and versioned 1. State enums and limits are machine-consumed constants. Zod HTTP schemas are strict and reject body scope/owner/company fields.
- Manifest input: `{kind, revision_id?, supplied_text, classification, source_revision_ids?, ...provenance}`. Kinds: source_revision/page_revision/catalog/question/instruction/schema_revision/prior_result. Every supplied context item gets its own input, even questions, schema and uncited catalog summaries. Catalog/prior_result must explicitly provide complete raw closure, including `[]` when genuinely no source was supplied. Any supplied page itself must also appear as a page_revision input; raw closure alone is not its identity. Questions are context, not factual evidence.
- `tx.manifest` fills current `{actor_id,wiki_id}` authorization, expands page raw closure, validates exact supplied source/page/schema text, raises classification to raw dependency sensitivity, and freezes `{inputs,hash}`. Each input stores zero-based ordinal and SHA-256 of exact UTF-8 supplied text. Hash is SHA-256 of canonical sorted-key JSON of the **complete ordered** input list, distinct from request hash. Do not select only eventual citations or omit inputs that produced no citations. Every accepted canonical field (including nested catalog/prior-result provenance and extension fields) is persisted in `input_json`, preserving array/input order. Rebuilding `freezeManifest(rows ordered by ordinal.map(row => JSON.parse(row.input_json)))` must reproduce the accepted hash; normalized columns alone are not the complete manifest. Worker-supplied context/provenance must be lossless JSON data: top-level enumerable accessors are evaluated once and normalized to plain data, while nested accessors, undefined, non-finite numbers, functions, symbols, sparse arrays, cycles, Date/Map/Set and class instances are rejected before dispatch. Canonical JSON normalizes object-key order and numeric negative zero. Content remains untrusted data, never instructions or capabilities.
- Citation DTO: `{artifact_kind:'source_revision'|'page_revision',revision_id,revision_sha256,start_byte,end_byte,span_sha256}`. `citationFor(revision,start=0,end=UTF8Length)` and `restoreSpan(revision,citation)` are pure anchor helpers, **not authorization gates**. Use transaction validation before exposing a citation. Server restores `[start,end)` from immutable text, rejects continuation-byte endpoints/empty/out-of-range spans and checks both hashes. Source revision preserves original bytes as base64 and separate original/content hashes; extraction revision ID is immutable. CRLF and repeated passages are not normalized or located by `indexOf`.

## Retrieval DTO

```js
retrieveKnowledge(context, {
  question: 'nonblank, max 4000 characters',
  retrieval: {raw: true, published_wiki: true, source_revision_ids: optionalIds}
})
// {items:[{...authorizedRevision,authorized:true,score,citation}],coverage:{
//   raw,published_wiki,authorized_candidates,selected_revision_ids,
//   limits:{sources:20,pages:20},truncated:false}}
```

Both targets false is 400. An empty Wiki with raw sources is valid. Only fresh/current permitted candidates enter ranking; unauthorized candidates are absent from counts too. Lexical ranking uses complete immutable text. Matched result counts beyond 20 source/20 page return 422, not a successful prefix. Returned spans cover the selected full texts; Task 32 must include **all** dispatched content and account for actual model context/output reserve, failing explicitly on overflow. No model is called here and no answer is fabricated. No-match returns empty evidence, not model failure. Explicit stale selected source IDs return 409; unavailable/private/foreign selected IDs and direct private/foreign revision HTTP reads return 404.

## HTTP surface supplied here

Mounted before generic IDs at `/vault/wiki`, `/documents/wiki`, `/pg/vault/wiki`, `/pg/documents/wiki` (under existing `/api/v1`).

- GET root: `{wiki:null,pages:[]}` on empty storage; does not fabricate or insert knowledge.
- POST `/sources`: record `{kind:'record',origin_kind,origin_id,version}` or upload `{kind:'upload',filename,mime,content_base64}`. UTF-8 md/txt extraction and 1,000,000-byte limit reuse existing upload validation. New 201, current record replay 200.
- POST `/sources/:id/revisions`: record `{expected_version,version}` or upload `{expected_version,filename,mime,content_base64}`; 201.
- GET `/sources`, GET `/sources/:id/revisions/:revisionId`, DELETE `/sources/:id` with `{expected_version}`.
- GET `/pages`, GET `/pages/:id?revision=...`, GET `/index.md`, `/log.md`, `/schema.md`. All are private/no-store/nosniff. Index/log only project authorized data. Private job/change-set events are deliberately excluded from this foundation log until their owning worker supplies its fresh predicate. Schema on an empty Wiki is the application-owned schema, not published knowledge.
- No `/jobs`, model tools, fake job responses, publication actions, SSE or graph route are introduced by Task 31. They remain the explicitly assigned follow-on workflows.
