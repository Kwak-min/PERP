# Integrated Wiki consumer handoff to Task28

Verified integration base: HEAD `cf41e63d5aed97ade42918b1b8c1a76bbcc00ec2` plus pending publication MERGE_HEAD `32a2cbb9a00550888dc5b6966bd075ee8a5e3ea6` and the unstaged fixes recorded in `.omo/evidence/integration-wiki-publication/`. No Task28 screen is implemented here.

## Transport and scope

All paths below are relative to `/api/v1`. Choose an actual root explicitly:

| Store/scope | Root |
|---|---|
| legacy personal | `/vault/wiki` |
| legacy company | `/documents/wiki` |
| PG personal | `/pg/vault/wiki` |
| PG company | `/pg/documents/wiki` |

Use `Authorization: Bearer ...` and `X-Org-Id` (PG company selection is `pg:<id>`). Never supply actor/store/scope/company in request bodies. PG personal ownership is independent of company selection. Original authenticated parent routers mount publication before source/jobs projections. Jobs and `server.js` startup/shutdown worker remain mounted.

`apiRequest(path,{method,body,session,signal,headers})` returns `Promise<unknown>`; parse the actual DTO in Task28. Supply `headers:{'Idempotency-Key':key}` for admission/publication. It does not automatically prefix `/pg` for PG workspaces. `workspaceEndpoint` can map a `/pg/documents/...` path back to legacy for a legacy selected org; `/pg/vault/...` stays PG. Do not use database fallback on failure.

`apiEventStream(path,{session,signal,cursor?,onEvent})` returns `Promise<void>`. Only the four exact root `/events` paths are accepted; no query token. It sends `Last-Event-ID`, Bearer and company headers. Callback shape is `{id:string|null,event:string,data:unknown}`. Abort and discard all old scope responses on owner/company/store change. Reconnect after bounded server closure using the last authorized event sequence, not Wiki generation. No automatic reconnect is provided by this helper.

## Sources and empty Wiki

`GET root` -> `{wiki:null|WikiRow,pages:[{id,revision_id,title,kind,version}]}`. Empty Wiki is a valid authenticated state, not a reason to disable raw research.

- `POST /sources`: record `{kind:'record',origin_kind:'note'|'document',origin_id,version}` or upload `{kind:'upload',filename,mime,content_base64}`. Fresh creation201; existing exact registration200. Returns SourceRow plus `created`.
- `GET /sources?cursor=<opaque-id>&limit=50`: `{items:SourceRowWithTitleAndFreshness[],next_cursor:string|null}`; limit1..100.
- `POST /sources/:id/revisions`: `{expected_version,version?}` for records, or `{expected_version,filename,mime,content_base64}` for uploads; response201 SourceRow. `expected_version` is the Wiki source CAS; `version` is the original record version token.
- `DELETE /sources/:id`: `{expected_version}` -> `{id,withdrawn:true,version}`.
- `GET /sources/:sourceId/revisions/:revisionId`: immutable raw source revision with `content`, original/extraction/content hashes and base64, `artifact_kind:'source_revision'`, `freshness`, `source_id`, `source_identity:{store,company,owner,kind,opaque_id}`. It currently includes `restrictions_json` as a JSON string. Use exact bytes/revision, not live original text, for citation display. Do not persist private snapshots across scope lifetimes.
- `GET /schema.md`, `/index.md`, `/log.md`: text/markdown, not JSON. Schema is read-only. Index/log are authorized server projections.

Source writes require document mutation authority; reader research does not grant registration/recapture/withdrawal. Source limit1,000,000 bytes is storage capacity, not a model context guarantee.

## Private jobs and exact query drafts

`POST /jobs` requires printable non-whitespace ASCII `Idempotency-Key`1..200; admission202, exact replay200, changed request409. Bodies:

```js
{operation:'ingest',source_revision_ids:string[],target_base_versions?:[{page_id,version,published_head_id}]}
{operation:'query',question,retrieval:{raw:boolean,published_wiki:boolean,source_revision_ids?:string[]}}
{operation:'lint',page_revision_ids:string[]}
```

Question <=4000 chars; sources/pages <=20, no duplicate IDs. Query enables at least one retrieval surface. `GET /jobs/:id` and admission return JobDTO:

```js
{id,operation,state,fence,current_attempt_id,failure_code,result,input_manifest_hash,created_at,updated_at,attempts}
// attempts: [{id,ordinal,fence,model_version,configuration,input_manifest_hash,
//             result_hash,started_at,finished_at,failure_code}]
```

`state` is `queued|running|succeeded|failed|unavailable`. `result` is null or:

```js
{result_revision_id,operation,review_state:'unreviewed',answer_md,citations,
 citation_validation,freshness,input_manifest_hash,provenance,uncertainty,
 retrieval_coverage,change_set_id,issues}
```

`citation_validation` is `anchors_valid|no_evidence`. `provenance.anchor_meaning` is `traceability_not_verified_truth`; valid anchors are NOT truth verification. Coverage preserves `selected_revision_ids`, exact `selected_spans`, selected surfaces, candidate count, limits, `truncated:false`. Lint issues distinguish `kind:'structural'` from `kind:'model_suggestion'`. Do not fabricate missing output or label every failure no-evidence.

`POST /jobs/:id/retry`, `/cancel`, `/draft` all require strict `{}`. Retry/cancel return JobDTO. Draft returns `{change_set_id,manifest_hash,result_revision_id}`; it freezes the exact successful cited query result once and replays without changing `job.result_json`. Ingest/lint can already return `result.change_set_id`; none publishes automatically.

Company query admission/replay/dispatch/heartbeat/accept/retry/cancel needs current `menu.documents` + `document.read`. Ingest/lint additionally need write. Exact query draft creation AND replay need current read AND write in the same locked transaction. Only the requesting actor owns a private job/draft; admin status does not transfer ownership. No job listing, change-set listing, public claim/heartbeat/acceptance or model-configuration endpoint exists.

No-evidence can succeed with `answer_md:null` without any model call; unavailable model is durable `unavailable` with a failure code. Source mutation can proactively set `unavailable/SOURCE_REVOKED` and invalidate a late lease (`LEASE_LOST`). Role changes wake fresh checks without cancelling an otherwise read-authorized query. Actual denied workers retire via fixed metadata-only code, not a permission bypass. Retry after stale input fails409 and requires a new job.

## Review, publication and pages

- `GET /change-sets/:id` -> ChangeSetDTO (row scalar fields plus parsed `proposed_revisions`, `expected_heads`, `lineage`, `freshness`, `diff`; storage JSON-string columns are removed).
- `diff[]`: `{page_id,before:null|{revision_id,title,markdown},before_state:'current'|'stale'|'unavailable'|'absent',after:Proposal}`.
- Proposal: `{page_id,kind:'page'|'entity'|'concept',title,markdown,index_entry,citations,links,provenance}`. Nonblank frozen title bytes are not normalized after hashing. New page/link UUIDs are server-assigned.
- ExpectedHead: `{page_id,version:number|null,published_head_id:string|null}`; both null for a new page.
- `lineage` is complete `{inputs,hash}`, including uncited dependencies, NOT the citation subset. `input_manifest_hash===lineage.hash`.
- `POST /change-sets/:id/publish`: `{manifest_hash,confirmed:true}` plus `Idempotency-Key`; returns PublicationRow with **parsed** `result_json:{page_revision_ids,page_ids,pages:[{id,revision_id,version}]}`. Exact authorized replay returns the same receipt. Missing confirmation400; changed digest/key/head/schema/current dependency fails closed. Show/confirm the server-inspected digest, never recompute a review snapshot client-side.
- `POST /change-sets/:id/reject`: `{manifest_hash}` -> `{id,wiki_id,state:'rejected',manifest_hash}`.
- `POST /pages/:pageId/change-sets`: `{expected_version,title,markdown}` ->201 **storage-shaped ChangeSetRow**, including JSON-string `proposed_revisions_json`, `expected_heads_json`, `lineage_json`. Follow its `id` with GET `/change-sets/:id` for the review DTO. Manual changes preserve full contributing lineage and produce a draft, not an immediate head update.
- `GET /pages`: `{items:[{id,revision_id,title,kind,version,freshness}],next_cursor:null}`.
- `GET /pages/:pageId?revision=<revisionId>`: PageRevisionDTO. Without `revision`, only current authorized head. Fields include `id` (revision ID), `page_id`, `wiki_id`, `title`, `markdown`, `index_entry`, `content_sha256`, **JSON-string** `citations_json`, `links_json`, `provenance_json`, `input_manifest_hash`, `schema_revision_id`, `actor_id`, `created_at`, plus `artifact_kind:'page_revision'`, `content`, `freshness`, `version`, `kind`.
- `GET /pages/:pageId/history`: `{items:PageRevisionDTO[]}`; current/stale explicit, unavailable404, only immutable published receipts' revisions.
- `GET /pages/:pageId/backlinks`: `{items:GraphEdge[]}`, including either incident side for undirected links.

Review read, manual mutation and explicit publish use their ordinary scoped read/write authority and fresh full-lineage gates; the job bookkeeping capability is not a general HTTP write facade. Limits are20 proposed pages,200 aggregate page citations + links,262144 output bytes. Nothing edits original source records or grants workers publication authority.

## Citation, graph and events DTOs

Citation is exactly `{artifact_kind:'source_revision'|'page_revision',revision_id,revision_sha256,start_byte,end_byte,span_sha256}`. Offsets are UTF-8 bytes, end exclusive, not JavaScript character positions. Resolve the exact revision and verify the complete revision/span hashes. The source list maps revision IDs to source IDs; page graph/list/history maps page revision IDs to page IDs. There is no standalone `/citations/:id` lookup endpoint.

`GET /graph` -> `{nodes,edges,counts:{nodes,edges}}`:

- Page node `{id:'<kind>:<page-id>',kind,page_id,revision_id,title,version,freshness}`.
- Source node `{id:'source:<source-id>',kind:'source',source_id,revision_id,title,freshness}`.
- Citation edge `{id:'citation:<page-revision-id>:<ordinal>',type:'citation',origin:'citation',direction:'directed',source:<typed-id>,target:<typed-id>,citation,source_revision_id:<page-revision-id>,target_revision_id,review_state:'published'}`. Note `source_revision_id` on an edge is the originating PAGE revision.
- Link edge `{id,type:'manual'|'ai_derived',target_page_id,predicate:'related'|'supports'|'contradicts'|'supersedes',direction:'directed'|'undirected',origin:'human'|'compiler',citations,source:<typed-id>,target:<typed-id>,source_revision_id,target_revision_id,review_state:'published'}`.

Preserve stable IDs, every parallel edge, direction, provenance and exact revision anchors. Counts, authorized resolution, backlinks and titles come from the server. Never infer hidden nodes from unavailable dependencies.

SSE emits `state` data `{counts:{nodes,edges},cursor}` and `wiki` data `{sequence,kind,created_at,page_revision_id?,source_revision_id?,job_id?,change_set_id?}`. `state.cursor` precedes that drain's emitted wiki frames; advance from authorized `wiki.sequence`/frame ID. Stored event metadata, actor payload, source bodies and private other-actor jobs are excluded. Errors after headers emit `unavailable` with `SOURCE_REVOKED|SERVICE_UNAVAILABLE`, then close. Connections last <=60 seconds and close on backpressure. An empty scope adopts later Wiki creation. Generation is NOT an event cursor; restricted job bookkeeping/manual drafts can append events without a generation change.

## Renderer handoff is a real type gap, not a cast

Existing `KnowledgeGraphStage` props are `{data:KnowledgeGraphStageData,scopeKey,ariaLabel,emptyMessage,onNodeSelect?}` and selected node is the original immutable DTO. It is verified with the actual pinned `3d-force-graph1.80.0` / `three0.185.1`, controls, keyboard, parallel geometry, StrictMode, scope teardown and context loss.

However its current model is the old record graph: `GraphIdentity.kind` is only `note|document|space`; relation kinds are `manual|wiki|link|ai_similarity|space|project`. Node requires `renderer_id,identity`; edge requires `target_id,source_renderer_id,target_renderer_id,target_title,kind,binding,resolution`. The stage legend/semantic edge row and current engine arrows also assume the old relationship model. **Do not cast the new Wiki graph into this DTO or map AI-derived evidence to AI similarity.** Task28 needs an explicit nonbreaking typed Wiki adaptation/extension that preserves source/page/entity/concept, citation/manual/AI-derived semantics, directed/undirected edges, and scope-qualified renderer identity; retain all existing record-graph callers and renderer teardown tests. That Task28-owned work was deliberately not implemented in this integration.
