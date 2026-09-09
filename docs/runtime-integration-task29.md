# Task29 server runtime integration

`backend/src/server.js` validates both cleanup configuration and nonblank local Wiki model configuration before the existing SQLite migration. It preserves every migration and the Wiki query/read versus publication/write policy. PostgreSQL schema provisioning remains the existing deployment responsibility, not an implicit new startup migration.

Only successful HTTP listening starts the existing Wiki worker and the independently configured CSV/receipt maintenance scheduler. No cleanup store is inferred from Wiki's `pg` name: cleanup accepts only explicit `legacy` / `perp_db` selections. Both cleanup selections remain blank/default-off; their shared interval, deadline, explicit database/upload-root requirements and worker-only PG URL limits are unchanged. The first cleanup run remains one interval after listening.

SIGINT/SIGTERM request both worker stops immediately and close HTTP admission. Repeated signals share the same shutdown. All three completions are awaited even when one rejects; only then are the application's SQLite handle and PG pool closed. Errors set exit status 1. Natural process exit exposes leaked referenced timers/threads instead of concealing them with `process.exit()`. An externally closed HTTP server also stops both workers. Existing in-flight HTTP requests are allowed to drain; this does not introduce a new forced-drain timeout policy.

The Wiki scheduler still uses its shipped `legacy` and `pg` stores. Blank `WIKI_LOCAL_MODEL_CONFIG` is not a Wiki scheduler disable switch: persisted jobs can still be recovered, including jobs containing previously captured configuration. No operational Wiki store selector/disable flag was added in this conflict resolution. Its existing application PG defaults are not cleanup opt-ins. Changing those Wiki defaults or introducing an independent Wiki-disabled mode requires a separate configuration decision.

## Verification boundary

The runtime integration fixture imports the shipped server, migrations, app, Wiki worker and cleanup scheduler. Transparent start/stop wrappers observe the real implementations; they do not replace dispatch, DB transactions, worker threads or abort behavior. Real HTTP admits a private Wiki query against an isolated synthetic local-model protocol fixture. Native SQLite/PG cleanup lock submission, concurrent HTTP health, partial-body HTTP draining, durable `MODEL_ABORTED`, worker exits and natural process teardown are observed with event barriers and controlled scheduler intervals.

Separate fault-injection cases reject only after a real worker stop, or after real HTTP close. Additional completion gates after real worker stops prove that neither an HTTP error nor the other worker's error permits early database teardown. These gates are seam tests, not substitutes for actual active-worker execution.

Imports-only, receipts-only and cleanup-disabled are operationally real variants. Unconfigured-model smoke is not represented as a disabled Wiki scheduler. Invalid cleanup selectors, missing explicit DB/root settings and invalid model configuration reject before database use. Related native tests retain the cleanup worker's URL connection/statement/lock limits and retention contracts.

Tests run through the isolated runner with explicit native PostgreSQL binaries and file-level concurrency 1. This base precedes the Task28 default-parallel fixture correction; no full/default-parallel suite claim is made. Evidence and exact receipts are in `.omo/evidence/integration-runtime/`.
