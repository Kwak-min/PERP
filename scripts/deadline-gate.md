# Deadline regression entry points (Task30 preparation)

This prepares regression execution, not release certification. F1-F4, final
built-Chrome UI review, fresh audits, deployment, and the final integrated matrix
remain separate. No command here loads private.env or a default production DB or
model configuration.

## Commands

```text
npm run test:deadline -- --list
npm run test:deadline -- --preflight --pg-bin "<PG18_BIN>" --model-config "<OWNED_MODEL_JSON>"
npm run test:deadline -- --pg-bin "<PG18_BIN>" --model-config "<OWNED_MODEL_JSON>"
node frontend/scripts/deadline-qa.e2e.mjs --scenario all --list
node frontend/scripts/deadline-qa.e2e.mjs --scenario all --pg-bin "<PG18_BIN>"
npm run test:deadline:gate
```

`test:deadline` runs the complete coordinated matrix. `--scenario all` runs its
browser subset, including both personal and company Wiki in both stores, and
builds the frontend before the delivered built-import regression. Native API,
root-parallel, standalone Reservation, and real-model tests are mandatory in the
complete matrix, not misrepresented as browser-only tests.

`--suite root|unit|build|native|reservation|browser|model` and repeatable
`--target <manifest-id>` select partial checks. Successful partial checks report
`partial-passed`, never a complete matrix. `--list` reports `planned` only when
all selected required files exist; otherwise it exits 2 with a `blocked` receipt
containing the selected targets and missing paths. It executes nothing.
`--preflight` reports `preflight-only` or exits 2 with `blocked`. The source JSON
manifest remains readable even when integration files have not landed.
Missing required files, unknown options/scenarios/targets, missing PG18, missing
standalone dependencies, or absent model opt-in cannot become skipped success.

The F3 placeholder `backend/tests/deadline-native.integration.mjs` never existed
in the delivered tree. Its exact coordinated replacement is:

```text
node scripts/run_deadline_gate.mjs --suite native --pg-bin "<PG18_BIN>"
```

The full machine inventory is `scripts/deadline-gate-manifest.json`. It explicitly
names every delivered `backend/tests/*.integration.mjs` file, not just the default
`.test.js` pattern. Root `.test.js` coverage remains the original `npm test`, with
Node's actual default test-file parallelism. Frontend direct tests, isolation
regressions, Wiki revision/runtime smokes, and Reservation tests outside its
package's default glob are additional targets. `knowledge-graphs` already aliases
the Wiki workflow; running `knowledge-wiki --store legacy` and `--store pg` covers
that same workflow plus the required personal/company distinctions.

## Isolation and completion

Every leaf gets a fresh `run_deadline_isolated.mjs` process, temporary root, empty
dotenv, DB path, and allowlisted environment. Native files never share the same
runner fixture paths. Unit/native targets run two at a time. Root and standalone
Reservation package tests retain their internal actual parallel contracts.
Browser leaves run in sequence because delivered screenshots/evidence paths are
shared; neither assertions nor event-gated concurrency races are disabled.
Reservation source tests explicitly register its own tsconfig from the ERP root.

An outer wrapper is supported without reexecuting this gate inside itself:

```text
node scripts/run_deadline_isolated.mjs node scripts/run_deadline_gate.mjs --target unit:frontend/scripts/deadline-approval-model.test.mjs
node scripts/run_deadline_isolated.mjs npm run test:deadline -- --pg-bin "<PG18_BIN>" --model-config "<OWNED_MODEL_JSON>"
```

Repeat capability arguments on the gate itself: an outer wrapper's ambient PG
variables deliberately do not count as explicit authorization. Each child has
its own completion deadline and cancellation/cleanup protocol. The existing
outer wrapper also has a 15-minute aggregate deadline; use the direct gate for a
matrix exceeding that bound. There are no sleeps or polling loops in the gate.
A failure stops new targets after already-active leaves finish cleanup. Every
unstarted required target is recorded as `notRun`, never successful.

The gate requires each wrapper receipt to confirm temporary removal and no
forced shutdown. Child exit codes propagate. Receipts/logs remain under
`.omo/evidence/deadline-runs/<uuid>/`; the aggregate command/coverage/result/cleanup
manifest is `.omo/evidence/deadline-gates/<uuid>/manifest.json`. These are ignored
local evidence, not source files. `releaseCertified` is always false.

## Secrets-free prerequisites and real model ownership

- Install root workspaces and the separate `Reservation/backend` lockfile. Generate
  the local Prisma client as required by that workspace; never db push/migrate a
  real database as a test prerequisite.
- Explicit PostgreSQL 18 binaries: postgres, initdb, pg_ctl, psql. Fixtures create
  their own databases/ports; neither PG env variables nor DATABASE_URL are used
  as authorization to contact a service.
- Chrome and local build dependencies. The complete gate builds the frontend;
  the delivered browser leaves otherwise use their own Vite/API fixtures.
- A caller-owned, isolated, already-loaded local model runtime with exclusive
  ownership for the duration of the smoke. The caller, not the gate, owns its
  startup and shutdown. Choose an unused non-protected loopback port, an explicit
  loaded model identifier, and matching context length. No default LM Studio
  inventory, private provider keys, external URL, or default server is consulted.

Explicit JSON format (values are illustrative, not defaults):

```json
{
  "opt_in": true,
  "ownership": "caller-owned-isolated",
  "configuration": {
    "base_url": "http://127.0.0.1:12345",
    "model": "gate-owned-smoke",
    "context_tokens": 8192,
    "output_tokens": 1024,
    "timeout_ms": 180000,
    "temperature": 0
  }
}
```

The existing real `deadline-wiki-model-smoke.mjs` still executes real Korean
synthetic ingest and raw-first query, validates fixed citations/provenance and
model identity/context, verifies unpublished drafts and unchanged source, and
cleans its DB fixture. Its former hardcoded runtime is replaced with the explicit
ownership envelope. Missing/unavailable/invalid model execution fails. Synthetic
browser providers do not substitute for this target.

Historical `task28-gemma.e2e.mjs` is intentionally not launched: it controls a
hardcoded user LM Studio installation. Its model capability is covered by the
explicit real compile/query smoke, while personal/company browser flows run
through the delivered Wiki scenarios. Running that historical script independently
requires a separately reviewed runtime-ownership migration; the gate does not
claim that real-model browser run occurred.

## Integration handoff

The mandatory final inventory is **95 gate targets**:
26 individually isolated native integration files plus the native Wiki revision
smoke, 29 browser leaves, 33 unit targets, root-parallel, frontend build, three
Reservation targets, and the real-model smoke. The bundle repair adds
`native:deadline-wiki-bundle-native`; its SQLite counterpart
`backend/tests/deadline-wiki-bundle.test.js` is required within `root:parallel`,
not an extra target. Both require the shared `deadline-wiki-bundle-scenarios.js`.
The three runtime root test files below also remain required inventory within
the existing root target, not three extra gate targets.

The finance chart repair extends the existing root analytics test, both native
analytics targets, the analytics model unit target, and `browser:analytics` /
`browser:analytics-pg`. No duplicate chart targets are added. Earlier 94-target
execution receipts remain historical evidence, not verification of this inventory.

These exact runtime/UI deliveries are already mandatory in the manifest, but are
absent from this gate's base `9928186`. Do not copy product code into this worktree
or remove missing paths to get green. Integrate the delivered runtime/UI changes
in the root integration tree; the unchanged preflight then accepts the files.

| Required delivery | Gate coverage |
| --- | --- |
| `backend/tests/deadline-cleanup-pg-limits-native.integration.mjs` | `native:deadline-cleanup-pg-limits-native` |
| `backend/tests/deadline-import-maintenance-native.integration.mjs` | `native:deadline-import-maintenance-native` |
| `backend/tests/deadline-receipt-maintenance-native.integration.mjs` | `native:deadline-receipt-maintenance-native` |
| `backend/tests/deadline-runtime-integration-native.integration.mjs` | `native:deadline-runtime-integration-native` |
| `backend/tests/deadline-import-maintenance-server.test.js` | `root:parallel` required file |
| `backend/tests/deadline-import-maintenance.test.js` | `root:parallel` required file |
| `backend/tests/deadline-runtime-startup.test.js` | `root:parallel` required file |
| `frontend/scripts/deadline-final-ui-fixes.e2e.mjs` | `browser:final-ui-fixes`, direct default-mode browser leaf |

The four new native files each receive their own isolated wrapper, with the same
two-target native parallelism. `deadline-runtime-startup.test.js` itself starts
native PG, so `root:parallel` now requires explicit `--pg-bin`; its actual `npm
test` command and default file parallelism remain unchanged. The standalone
`deadline-browser-session.test.mjs` target also explicitly requires Chrome.
The final UI leaf covers delivered sidebar focus, contrast, and role-label
accessibility checks; it is not a substitute for independent F3 manual QA.

`integrationRequired` lists these exact additions as machine data. The gate test
allows their absence only as an asserted missing-file block, never as an omitted
target or successful gate. All other missing files and unlisted delivered native
files remain regression failures. Merge the small shared dispatcher `all` branch
carefully; re-run the final matrix after these runtime/UI deliveries land.

## Mandatory separate final checks

The following six checks are mandatory **separate executions** on the final
integrated tree. They are not implicitly performed by `test:deadline` and are not
included in its 95-target count. The machine contract is `mandatoryFinalChecks`.

```text
node scripts/run_deadline_isolated.mjs npm run build --prefix Reservation/backend
node scripts/run_deadline_isolated.mjs npm audit --json
node scripts/run_deadline_isolated.mjs npm audit --prefix Reservation/backend --json
node scripts/run_deadline_isolated.mjs node scripts/check_structure.mjs
node scripts/run_deadline_isolated.mjs python scripts/check_docs_coverage.py
node scripts/run_deadline_isolated.mjs python scripts/check_deliverables.py
```

Root and Reservation tests and the frontend build remain gate targets, with
fresh execution evidence required on the final tree. Independent F1, F2, F3, and
F4 approvals remain separate from both the gate and these six checks; no gate
exit status certifies those reviews, deployment, commit, push, or merge.
