# Task33 Wiki publication interface

Base: `64e00f29bb1a1cd948f2c2903c642719e8c9a88f`. This interface extends the frozen Task31 transaction/DTO contract without changing its v1 schema or exposing SQL. It does not import Task32 files and grants no model or worker publication authority.

## Root integration

The actual app mounts `knowledgeWikiPublicationRouter(store, scope)` from `backend/src/routes/knowledge-wiki-publication.routes.js` at each existing Wiki root **before** Task31's `knowledgeWikiRouter(store, scope)`:

- `/vault/wiki`: `legacy`, `personal`
- `/documents/wiki`: `legacy`, `company`
- `/pg/vault/wiki`: `pg`, `personal`
- `/pg/documents/wiki`: `pg`, `company`

The publication router owns `/change-sets`, `/pages`, `/graph`, `/index.md`, `/log.md`, and `/events`; mounting first selects publication's authorized projections for overlapping paths. Express's exact `/pages/:id` does not capture extra history/backlinks segments. Task31 source routes and Task32 job routes remain unchanged. Apply SQLite migration 14 through `migrations.js`; deploy generated `db/perp_additions_v18_knowledge_invalidation.sql` once after Task31 PG v15. Wiki SQLite12/PGv15, CSV SQLite13/PGv16, and analytics PGv17 remain reserved for their owners.

Task32 query-only bookkeeping repair remains independent. Task33 write actions intentionally retain the frozen store's source mutation/publication write authority. Do not add a Task33 bypass or grant workers `publishChangeSet`.

## Change sets and publication

Task32 must persist change sets using the exact shared shape:

- `proposed_revisions_json`: canonical array of `{page_id,kind,title,markdown,index_entry,citations,links,provenance}`.
- `expected_heads_json`: canonical array of `{page_id,version,published_head_id}`; new pages use both null.
- `lineage_json`: canonical complete frozen `{inputs,hash}` from `tx.manifest(...)`.
- `input_manifest_hash`: `lineage.hash`.
- `manifest_hash`: `sha256(canonical({wiki_id,actor_id,job_id,proposed_revisions,expected_heads,lineage,schema_revision_id,input_manifest_hash}))`.

Use exported `changeSetDigest(fields)` to avoid key or null drift. Frozen proposal titles are nonblank and preserved byte-for-byte on decode, not trimmed after hashing. The 200-edge limit counts page citations plus links across the entire bundle; jobs reject excess before freezing a successful result. New page IDs and every link ID are server-generated UUIDs before freezing. Publication allocates immutable revision IDs transactionally and stores a canonical receipt whose `result_json` contains `page_revision_ids`, `page_ids`, and `{id,revision_id,version}` pages.

Service exports:

- `inspectChangeSet(context,id)`
- `publishChangeSet(context,id,{manifest_hash,confirmed:true},idempotencyKey)`
- `rejectChangeSet(context,id,{manifest_hash})`
- `createManualChangeSet(context,pageId,{expected_version,title,markdown})`
- `pageHistory(context,pageId)`, `wikiGraph(context)`, `wikiEvents(context,cursor)`

Only the requesting actor can inspect/reject/publish a private change set. Every call reauthorizes the full lineage. Authorized exact replay returns the original receipt and never advances heads again; changed key/snapshot, head, source, schema, or lineage fails closed.

## Read and stream DTOs

- `GET /pages`: `{items:[{id,revision_id,title,kind,version,freshness}],next_cursor:null}`.
- `GET /pages/:id`, `/pages/:id/history`, `/pages/:id/backlinks` expose only currently authorized full-dependency projections; stale history is explicit and unavailable history is 404.
- `GET /graph`: `{nodes,edges,counts}` with typed stable node IDs, exact revision anchors, directed/undirected and parallel citation/manual/AI-derived edges preserved.
- `GET /events`: authenticated SSE. Bearer and company selection are headers; query tokens are rejected. It emits `state` and authorized `wiki` frames, supports `Last-Event-ID` or numeric `cursor`, and omits stored event metadata.
- Frontend uses `apiEventStream` from `frontend/src/services/api.ts`; no native `EventSource` or URL token.

Task28 should consume these DTOs without reconstructing titles, counts, resolution, backlinks, edge direction, provenance, or authorization client-side.

## Invalidation coordination

Source mutation/withdrawal triggers increment Wiki generation and fence queued/running jobs to `unavailable` with `SOURCE_REVOKED`, clearing leases. Authority-table changes increment generation to wake fresh authorization checks; they do not blindly fence every job in the scope. A role grant or removal of only write permission must preserve a read-authorized query. Task32 derives current permission from the stored operation at dispatch/heartbeat/acceptance and uses metadata-only retirement on actual denial. Read/review/publication/SSE still reauthorize independently. Generation is not an event cursor: source capture, manual drafts/rejection and job bookkeeping can append durable events without advancing it. Every PG knowledge write transaction queues an empty `orbitflow_wiki_invalidated` notification, delivered only at COMMIT; existing generation-trigger DDL remains unchanged. SQLite coalesces empty wake markers and local hints in a microtask after the synchronous outer transaction finishes (also supporting in-memory SQLite). Generic model writes inside role/source transactions must not wake readers before COMMIT. A rolled-back transaction can produce a harmless hint; the durable authorized snapshot remains unchanged.

Subscribers install hints before their first snapshot, then compare the scoped Wiki identity, durable event sequence and invalidation generation. An empty scope has a stable authenticated `(store,scope,tenant,company,owner)` identity before the Wiki row exists. Notifications cannot select a scope; every refresh and emitted projection rechecks current permissions. Hints during a snapshot/drain queue another read, so the initial snapshot/subscription gap cannot drop a commit. Connections remain bounded to 60 seconds and backpressure closes them; reconnect replays authorized events after `Last-Event-ID` or `cursor`. No source body, title, actor/job payload or stored metadata travels in hints.

When composing Task32's additive restricted bookkeeping changes, retain its private `executeTransaction` runner and place the PG commit notification and SQLite postcommit wake there for every physical write, including restricted job bookkeeping and metadata-only retirement. Do not move publication/manual/source operations onto the job facade or expose a caller-selected authorization option. Preserve the existing jobs mount and worker lifecycle. This worktree does not import Task32 or claim combined worker verification.
