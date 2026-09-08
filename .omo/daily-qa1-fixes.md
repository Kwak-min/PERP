# Daily QA round1 blocker fixes

Task `st_01a07ff0`, 2026-09-08, Windows x64. Integration worktree `D:/00_정리파일/PERP`, branch `feat/daily-core-safe-operations`, starting HEAD `02ffadb`. All three requested blockers are fixed and verified. This is correction evidence for the lead's QA1 recheck, NOT QA round2/3 or live release approval.

## Atomic commits

| Commit | Verified unit |
| --- | --- |
| `4ad9196` | Q1-H1: finance browser route ownership, awaited route cleanup, real committed-response-loss retry retained. |
| `bec9850` | Q1-01: dedicated PG dues/approvals full-filter CSV; shared quoting/download and spreadsheet-formula neutralization; native browser regression. |
| `7f6f76b` | Q1-02: recipient inbox internal task links from attached metadata, visible first action column; actual legacy/native task detail and reload regression. |

No backend production, schema, permissions, version/idempotency protocol, or unrelated screen refactor was changed. No push was made. The separate report commit contains only this report.

## Fixes and RED -> GREEN evidence

Evidence root below is `.omo/daily-qa1-fixes/`. `artifacts.json` records artifact sizes/SHA-256 and read-only QA source hashes.

### Q1-H1

The old context-wide local `continue` handler overlapped the page-level lost-response handler; route removal did not await active invocations. Context routing now owns external-request rejection only. The transaction interceptor owns the response-loss scenario, and `unrouteAll({behavior:'wait'})` drains page/context handlers before teardown. Preview closes through its actual `httpServer` API. No error swallowing, ignored route errors, skipped assertions, sleeps, or retries-until-green were added.

- RED: exact QA `finance-browser.log`, copied to `harness-red.log`, SHA-256 `be55025e4121e25a5c33ad1cfff8ccda6572573e382914f4c2187ab11744cd8b`: `route.continue: Route is already handled!` at line28.
- GREEN before commit: `harness-green.log`, exit0, entire original entry.
- Final product GREEN: `finance-shipped-browser.log`, exit0, production Chrome152 + real Express/auth + isolated PGlite with migrations8/9/10.
- `captured/finance/lost-response.json`: actual server201 is fetched then aborted; unchanged form retries identical payload/key, returns the committed ID, and SQL count is exactly1. Approval ownership/decision once/reload, partial40.01+60.00 payment/history/replay, dues create/edit/delete, stale budget edit/delete409, retained audits, posted deletion409, exact summary `10000000000000010.00`, mobile fit and no page errors all pass.

### Q1-01

The bespoke screen had replaced the generic export UI. Both dedicated screens now export the same complete filtered row collection they display, independent of viewport position, including an empty header-only result. Stable explicit headers include record ID; dues preserve decimal strings without numeric conversion. Approvals include request timestamp, complete JSON payload, decision note and decision timestamp. Raw row IDs/metadata remain attached (including schema passthrough); versions are not converted to display cells or used to infer identity. Shared `downloadCsv`/`toCsv` retain UTF-8 BOM and quote comma/quote/CR/LF fields. The prior generic exporter only quoted fields, so formula neutralization was added once in the shared serializer, consistently protecting generic and dedicated exports.

- QA RED sources: read-only `PERP-daily-qa/.omo/daily-qa-round1/supplemental/result.json`, S01/S02:25 records, paid/rejected1, search intersection0, restore1, export control0 on each screen.
- New pre-production RED: `csv-browser-red.log`, `dues: filtered CSV action must exist`, expected1/actual0. `csv-unit-red.log`: shared exporter emits executable formula prefixes instead of neutralized values.
- Final GREEN: `csv-final-browser.log`, exit0. Fresh native PostgreSQL18.4, real HTTP/auth, production Chrome152; dues and approvals each download25/all,1/status,0/intersection,1/restored, plus13/24 search matches. All IDs, stable header arrays, equal row widths, exact `9999999999999999.99`,1.01/1.01/0.00 paid amounts, multiline quoted values, JSON payload, timestamps and neutralized formula prefixes are checked in actual downloaded CSV files. Foreign-company records are seeded and excluded.
- Evidence: `captured/csv/result.json`, ten `captured/csv/*.csv` files, `dues-filtered.png`, `approval-filtered.png`. Both screenshots were opened and inspected.
- Generic list GREEN: `list-final-browser.log`,9/9. Full25 and25/12/1/0 exports; filtered second/ninth/last-row mutations target only attached IDs23/16/1 and observed versions; metadata stays attached; foreign company rejected.

### Q1-02

`liveTable` already retained complete `row.values` while displaying six cells. The generic inbox now reads its task destination from those attached values, not a cell index. A first-column React Router link makes the destination immediately visible without horizontal scrolling. Only internal `/tasks/<identifier>` paths are accepted; external URLs, protocol-relative URLs, script schemes, traversal, query/hash destinations and encoded path separators do not become links. Six-column formatting and attached versions/IDs remain unchanged. Task detail still obtains fresh authorized server data; no notification row data is substituted for it.

- QA RED: `PERP-daily-qa/.omo/daily-qa-round1/independent/notification-link-observation.json`: `hrefs:[]`, row click stays `/notifications` despite persisted `/tasks/1`.
- New pre-production RED: `notification-browser-red.log`: expected3 task anchors, received0 after actual recipient login/reload (legacy branch); QA above separately establishes the PG failure.
- Final GREEN: `notification-final-browser.log`, exit0, both legacy SQLite and real native PG18.4. Recipient sees exactly the three expected task links after reload; foreign-company/other-recipient sentinels are absent. The second task's link is in the viewport, clicks to its exact URL, GET200 returns the exact task ID, and the actual detail title/form survive reload. The PG read-only recipient's save control remains disabled.
- Native reassignment no-op/version retention, concurrent200/409, history/notification storage failure rollback, preserved draft, foreign-resource404 and original correction flows remain green.
- Evidence: `captured/notifications/{legacy,pg}-recipient-link.json`, inbox and task-detail PNGs. Final inbox screenshots were opened and show usable links at the left edge; actual task detail screenshot was inspected.
- Focused model coverage verifies link metadata beyond six cells after search/page transforms and rejects unsafe destinations.

## Exact verification commands

All invocations ran from the integration root. `node .omo/run-daily-complete-isolated.mjs` starts an environment-allowlisted child: nonexistent dotenv path, temporary SQLite, invalid non-live default PG endpoint, empty inherited DB/provider credentials, echo AI, no inherited NODE_OPTIONS. Native helpers alone select freshly initialized local ephemeral PG clusters. Browser traffic is the built SPA -> owned Express -> synthetic database; no live service is a test target.

Native tools were installed using:

```bash
node .omo/run-daily-complete-isolated.mjs npm install --prefix C:/Users/A/AppData/Local/Temp/daily-qa1-fix-tools-VINJKN --offline --ignore-scripts --no-audit --no-fund --save-exact @embedded-postgres/windows-x64@18.4.0-beta.17
```

The tool directory was removed after verification. Reproduction requires a newly owned ASCII temp prefix containing that exact package; substitute its bin path rather than using any live database.

| Exact invocation | Result / evidence log under `.omo/daily-qa1-fixes/` |
| --- | --- |
| `node .omo/run-daily-complete-isolated.mjs node --check frontend/scripts/daily-finance.e2e.mjs` | exit0; `harness-syntax.log` |
| `node .omo/run-daily-complete-isolated.mjs node --check frontend/scripts/daily-finance-csv.e2e.mjs` | exit0 |
| `node .omo/run-daily-complete-isolated.mjs node --check frontend/scripts/daily-corrections.e2e.mjs` | exit0 |
| `node .omo/run-daily-complete-isolated.mjs node node_modules/typescript/bin/tsc -b frontend/tsconfig.json --pretty false` | exit0; `notification-final-types.log` (no diagnostics) |
| `node .omo/run-daily-complete-isolated.mjs npm run build` | exit0; `notification-final-build.log`; final `index-CGDewl6S.js` |
| `node .omo/run-daily-complete-isolated.mjs node --test frontend/scripts/screen-table.test.mjs` | RED exit1 `csv-unit-red.log`; GREEN6/6 `csv-unit-green.log` before notification model test; final7/7 in focused command below |
| `node .omo/run-daily-complete-isolated.mjs node --test frontend/scripts/screen-table.test.mjs backend/tests/pg-daily-finance.test.js backend/tests/project-assignment-notifications.test.js backend/tests/daily-corrections.test.js backend/tests/daily-pg-corrections.test.js backend/tests/pg-usage-tasks.test.js backend/tests/pg-org-audit.test.js` | exit0,48/48,0 skipped; `focused-final.log` |
| `node .omo/run-daily-complete-isolated.mjs npm test` | exit0,305/305 backend,63/63 route contract,10/10 Markdown,0 skipped; `root-final.log` |
| `node .omo/run-daily-complete-isolated.mjs node frontend/scripts/daily-finance.e2e.mjs` | exit0; `harness-green.log`, final `finance-shipped-browser.log` |
| `DAILY_LIST_BUILT=1 node .omo/run-daily-complete-isolated.mjs node --test frontend/scripts/daily-list-safety.e2e.mjs` | exit0,9/9; `list-final-browser.log` |
| `DAILY_TEST_PG_BIN=C:/Users/A/AppData/Local/Temp/daily-qa1-fix-tools-VINJKN/node_modules/@embedded-postgres/windows-x64/native/bin node .omo/run-daily-complete-isolated.mjs node frontend/scripts/daily-finance-csv.e2e.mjs` | RED exit1 `csv-browser-red.log`; final GREEN exit0 `csv-final-browser.log` |
| `DAILY_TEST_PG_BIN=C:/Users/A/AppData/Local/Temp/daily-qa1-fix-tools-VINJKN/node_modules/@embedded-postgres/windows-x64/native/bin DAILY_BUILT=1 node .omo/run-daily-complete-isolated.mjs node frontend/scripts/daily-corrections.e2e.mjs` | RED exit1 `notification-browser-red.log`; final GREEN exit0 `notification-final-browser.log` |
| `FINANCE_TEST_PG_BIN=C:/Users/A/AppData/Local/Temp/daily-qa1-fix-tools-VINJKN/node_modules/@embedded-postgres/windows-x64/native/bin node .omo/run-daily-complete-isolated.mjs node backend/tests/pg-daily-finance-native.integration.mjs` | exit0;19 real write-stage rollback checks, native concurrent replay once/payment and decision conflicts, balanced journal, retention and exact summary; `finance-native-green.log` |
| `node .omo/run-daily-complete-isolated.mjs node .omo/daily-qa1-fixes/cleanup.mjs` | exit0; `cleanup.log`, `cleanup.json` |
| `node .omo/run-daily-complete-isolated.mjs node .omo/daily-qa1-fixes/capture.mjs` | evidence copies and SHA-256 manifest; `capture.log`, `artifacts.json` |

LSP diagnostics were requested for every changed code/test file, but `typescript-language-server` is not installed. No dependency/global installation was made merely for LSP. Actual TypeScript project diagnostics and JS syntax validators above passed. Existing Vite >500kB chunk warning remains visible; no warning suppression was added.

## Failed tooling attempts retained, not counted as passes

- `csv-browser-setup-failed.log`: shell backslash quoting produced an invalid Node expression and empty native-tools prefix; initdb failed ENOENT before scenarios. Corrected invocation uses the exact explicit Windows path above.
- `csv-browser-red-unhandled.log`: initial RED download helper registered an event but waited on a nonexistent button, producing an unhandled download timeout. The test now asserts action existence before waiting and awaits download/click together with `Promise.all`. The replacement RED faithfully fails the missing export assertion and cleans itself. No production fix had yet been applied.
- That aborted test left one owned PG cluster/SQLite temp/browser profile. `owned-inventory.json` proves exact creation within its failed-run interval; `orphan-stop.log` records graceful shutdown using its exact data directory, not a generic process kill. All three were removed during guarded cleanup.
- `csv-types-path-failed.log`: TypeScript executable was root-local, not frontend-local. Correct root path passes with no diagnostics.
- `notification-browser-evidence-lifetime-failed.log`: new evidence collection tried to read a response body after navigating away. The test now captures and asserts the returned task ID before reload, then retains that parsed body. Final complete legacy/native run passes; no expectations were weakened.
- Expected storage-injection ERROR/P0001 logs in otherwise passing native tests are the asserted rollback cases, not suppressed failures.

## Cleanup and handoff boundary

`cleanup.json` checks9 recorded native clusters absent,25 distinct owned ports with no listeners, no remaining processes from the uniquely owned native-tools directory, and deletion of that tool directory. Only the failed-run's exact three timestamp-proven orphan paths were removed; only its owned PostgreSQL was stopped, using `pg_ctl -D <exact-data> -m fast -w stop`. Subsequent final root/focused/finance checks exited0 and their fixture cleanup completed.

The QA worktree remains detached at `02ffadb7b5fc174c8254aa592c4d3b4b381f667d`, with empty `git status --short` and diff. Its source/evidence was only read; no build/test, cleanup or Git write ran there. Integration's pre-existing untracked `DEV/` and `PERP-home-restore/` were untouched. Evidence copies, final production build and pre-existing dependencies are retained.

No private `.env`, real data, actual8000/8080/55432 HTTP/DB endpoint, provider service, or remote DB was read/mutated/contacted as part of testing. OS process metadata was inspected for owned cleanup; no user process was stopped or reconfigured. Live migration/deployment/runtime acceptance remains lead-owned. Assumptions: approved notification channel is persisted in-app delivery; recipients must retain their existing task-read permission to view details; exported internal version metadata is retained on rows but not presented as spreadsheet columns. No new permissions are granted by either UI fix.

**Disposition: requested QA1 blockers fixed and green on the integration branch; lead QA1 recheck and sequential QA2/QA3 remain unclaimed.**
