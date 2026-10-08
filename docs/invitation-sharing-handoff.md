# Organization invitation sharing - st_01a0869f

## HTTP clipboard correction and latest export (2026-09-09)

The parent identified that the deployed HTTP origin has no `navigator.clipboard`. No shared copy utility exists in this source tree. `InvitationSharingPanel` now uses the Clipboard API when available and otherwise performs synchronous selection plus `document.execCommand('copy')` inside the user's click. The temporary selection field is removed and the prior focus restored in `finally`, including false-return and thrown-error failures. Failure never reports success, and the existing selectable read-only code/link inputs remain available for manual copying. No browser security settings were disabled.

Only `frontend/src/screens/members/InvitationSharingPanel.tsx`, `frontend/scripts/invitation-sharing.e2e.mjs`, and this handoff changed since the prior verified export. Backend source and evidence are preserved; backend/auth/assignee suites were not rerun for this frontend-only correction.

| Latest validation | Exit | Run ID under `.omo/evidence/deadline-runs/` |
| --- | --- | --- |
| Regression before fix: Clipboard API unavailable, copy shows error instead of success | 1 (expected) | `d093fca8-cd22-49ed-ae94-3ea9a2c88548` |
| TypeScript/Vite production build | 0 | `e8e52afe-74c2-4697-8fbb-1a0531d1f7eb` |
| Affected invitation Chrome suite, all 8 flows | 0 | `83326b56-b25c-467c-a5d2-7c8ece7b043b` |

Each run has `result.json`, stdout, and stderr. The browser suite uses the truthful HTTP-equivalent condition of `navigator.clipboard` being unavailable, not a claim that localhost itself is insecure. Four cases (PG/SQLite at 375/1280) remove that API and grant no clipboard permissions. Actual copy operations use the browser's native execCommand and OS clipboard; a pre-subscribed paste event and real Ctrl+V in the receiver page prove the exact code/link payload. Four API-available cases also prove real paste. The suite checks preserved button focus/input selection, native manual Ctrl+C/Ctrl+V, copy rejection returning false, copy throwing, truthful error feedback, and recovery after failure. Only the rejection paths mock execCommand; successful copy/paste is never mocked. All original invitation acceptance/store-isolation flows still pass.

Current browser evidence: `.omo/evidence/invitation-clipboard/83326b56-b25c-467c-a5d2-7c8ece7b043b/results.json` (`clipboardChecks`) and adjacent screenshots. Previous browser/backend evidence remains at its original paths. LSP remains unavailable; build/syntax checks pass, with the existing Vite chunk-size warning.

The refreshed standard **26-file** patches and `manifest.json` remain under `.omo/evidence/invitation-integration/`, with new checksums. The export still targets f761d01; the parent owns integration with subsequent company/calendar/HR increments. **The parent must OMIT only the `frontend/src/screens/recruitment/PipelinePanel.tsx` hunk because recruitment frontend retirement supersedes it; do not restore that file.** `InvitationSharingPanel.tsx` remains required. The standard export retains PipelinePanel solely for the agreed manifest; no retirement or main-worktree edit was performed here. The original dirty invitation worktree remains unchanged. Administrator preapproval followed by recipient acceptance remains unchanged.

## Integration-ready delta against f761d01 (2026-09-09)

Current integration worktree: `D:/00_정리파일/PERP-wt/invite-integration-st01a0869f`, branch `integrate/invite-st01a0869f`, base `f761d01e606fbb03047e115cbb496475dd68fa15`. The original dirty `invite-code-sharing` worktree is preserved; its 26 file hashes, HEAD, and status were recorded and rechecked. No commit, push, main edit, or production access occurred.

The full 26-file invitation diff was applied using the installed Senpi `apply_patch` implementation with zero fuzz. The two overlapping files required no conflicting hunk replacement:

- `backend/src/routes/pgAuth.routes.js`: retains f761d01's `/projects/:id/task-assignees` route; adds only the invitation import/routes.
- `frontend/src/screens/ProjectTaskScreen.tsx`: retains the separate project heading and `canAddProjectMember` prop; adds only the existing six-line focus/access refresh effect.

The assignee controllers, keyed replay implementation, task creation modal, AppShell, and navigation catalog remain identical to f761d01. PipelinePanel is retained until the separate recruitment retirement increment. Approval semantics remain administrator recipient/role preapproval followed by recipient acceptance. The pending product question about a request-to-admin queue is not implemented.

### Combined-source verification

All commands ran from this new worktree against isolated SQLite/native PostgreSQL 18.6 and its own production build. Each listed run exited **0**; result files are `.omo/evidence/deadline-runs/<run-id>/result.json` and confirm temporary-root cleanup.

| Validation | Result | Run ID |
| --- | --- | --- |
| Fresh locked dependency installation | npm ci, 0 audit vulnerabilities reported | `6c950b63-37fd-4760-b134-db8f281fd050` |
| Related auth/invitation/role/security + assignee native tests | 128 passed; 0 failed/skipped | `5d394e76-2e48-479a-a869-4653fce55388` |
| TypeScript/Vite build | passed | `145856ee-d5a8-42af-9b5e-a183c038bafc` |
| Invitation Chrome flow | all 8 PG/SQLite signup/login/store-recovery cases passed | `c8316176-361b-4625-9f8c-897903f9c80d` |
| Auth-transition Chrome flow | all 10 scenarios passed | `54da70ea-067d-414a-b288-fd6853c01d46` |
| Assignee Chrome flow | both stores, separate project/task navigation, 4 lost-response cases each retaining one task/notification | `40fa58f8-dbc1-4801-bce4-88914f5f9172` |
| Manual desktop Chrome using Orca | wrong-store recovery, login, verification, acceptance, prior memberships retained | `824c764b-7941-4e81-9702-76d8013df7f7` |

Intentional audit/notification failure logs verify transaction rollback; no test failed in these combined-source runs. Node syntax checks and `git diff --check` pass. LSP remains unavailable (`typescript-language-server` not installed); the existing Vite large-chunk warning remains. No external share delivery or email was sent. Screenshots and machine results are under this worktree's `.omo/evidence/st_01a0869f/`, `.omo/evidence/st_01a08625/`, and `.omo/evidence/project-task-create-assignee/`.

### Patch and manifest

Artifacts are under `.omo/evidence/invitation-integration/`:

- `invitation-f761d01.apply_patch`: complete 26-file patch for apply_patch.
- `invitation-f761d01.patch`: equivalent full-index unified Git patch.
- `manifest.json`: exact paths, before/after SHA-256 hashes, patch SHA-256 hashes, base/tree, commands, exit evidence, preservation checks.
- `original-snapshot.json` and `apply-result.json`: original-worktree preservation and initial application evidence.

Apply the complete delta to a clean f761d01-based integration checkout. Do not copy the older overlapping whole files from `invite-code-sharing`. No new DDL is needed beyond the existing prerequisites documented below. Both exported patch formats are checked against clean base contents; Git's resulting tree and apply_patch's resulting file hashes are checked against the verified source. The real worktree index remains unstaged; alternate indexes used for patch validation do not create a commit.

Reproduce the combined checks (existing invitation/auth commands below are also current):

```text
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node --test backend/tests/invitation-sharing.test.js backend/tests/invitation-sharing-native.integration.mjs backend/tests/member-provisioning-security.test.js backend/tests/custom-role-settings.test.js backend/tests/identity-lifecycle.test.js backend/tests/pg-custom-role-settings.test.js backend/tests/pg-agent-api-key.test.js backend/tests/deadline-project-candidates.test.js frontend/scripts/auth-return.test.mjs frontend/scripts/auth-transition.test.mjs
node scripts/run_deadline_isolated.mjs npm run build
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node frontend/scripts/invitation-sharing.e2e.mjs
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node frontend/scripts/auth-transition.e2e.mjs
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node frontend/scripts/project-task-create-assignee.e2e.mjs
```

## Archived original-worktree review handoff (2026-09-09)

All inherited changes remain in this worktree. No commit, push, merge, production access, or edits to another worktree occurred. The sections below retain the earlier st_01a08665 history; this section supersedes its incomplete login/store claims.

### Delivered continuation

- Fixed invitation login selecting PostgreSQL first regardless of origin. LoginPage now passes the tab's invitation to login; SQLite invites authenticate only in SQLite and PG invites only in PG. A credential rejection never falls through to the other store when an invitation is present. Without an invitation, the pre-existing PG-first/credential-only SQLite fallback contract remains unchanged.
- Signup continues to create only an account in the invitation's store through the SPA, without consuming the invitation. The legacy direct API's existing `invitation_token` signup/accept transaction remains compatible; the SPA does not invoke it.
- A signed-in account from the other store sees an explicit store-mismatch explanation and login/signup recovery actions. No verify/accept request is made with that mismatched session. Same-email accounts are not linked, merged, or given each other's company memberships.
- Closed the server bypass: PG bridge identities now receive 403 `PERMISSION_DENIED`, reason `store_mismatch`, on SQLite invitation verification and acceptance. SQLite sessions remain rejected by PG invitation APIs. Store hints never authenticate a user; real store credentials, recipient email, secret token, current inviter grants, and organization state still govern acceptance.
- On `/members` and `/org-chart`, **구성원 추가** opens the sharing form in both stores. PG's old direct-account creation remains available separately as **계정 직접 등록**. Recipient-specific seven-day links/codes retain explicit role selection and manual sharing.
- Existing approval semantics are preserved and explained in the form: an authorized administrator pre-approves one email and permitted roles by creating the invite, then the recipient explicitly accepts. There is no anonymous reusable grant link or new post-request admin approval queue. Adding such a queue would be a separate product decision.
- Existing users already in another company can accept and retain both memberships and access to their original company's data. The inviter cannot read that original company. No project/task behavior was changed by this continuation; inherited refresh changes were preserved. The separate custom-role-toggle reviewer owns that read-only review.

### Current verification and exit evidence

Every path below is relative to `.omo/evidence/deadline-runs/` in this worktree and ends in `result.json`, containing the process exit `code` and cleanup evidence.

| Run | Result | Evidence |
| --- | --- | --- |
| Initial auth/store regressions, before fixes | exit 1; 4 failures (wrong-store verification returned 200, SQLite invitation selected PG, credential fallback crossed stores) | `d5dd6b50-bfc8-42bb-8cba-8db4b5d3fbec/result.json` |
| New member-entry browser regression, before UI fix | exit 1; 구성원 추가 did not request invitation options | `0e662d10-2137-4335-999e-0d01e15ed12f/result.json` |
| Related native PG 18.6 + SQLite/security/auth tests | exit 0; 110 passed, 0 failed/skipped | `bdb469fe-dc0d-44c0-878d-46e923cd4e83/result.json` |
| TypeScript and Vite production build | exit 0 | `78228757-5b6c-4901-91a0-b5432fe48761/result.json` |
| Expanded Chrome invitation suite | exit 0; all 8 cases passed | `e2a1e838-1552-4b37-8d4b-d13ccbe90eec/result.json` |
| Existing Chrome auth transition suite | exit 0; all 10 scenarios passed | `0cdf3695-ffd7-48ca-a44e-ec751b737c97/result.json` |
| Manual desktop Chrome via Orca accessibility actions | exit 0; wrong-store recovery, login, verify, accept, both prior memberships retained | `b803bf73-1d21-427b-95fc-0559eaa180b1/result.json` |

The eight cases are PG/SQLite x signup, login, signed-in-other-store login, signed-in-other-store signup at 375/1280 widths. Every case has a separate account with the same email/password in the opposite store; existing-user cases also have a prior company in the invitation's store. They exercise sender create/real Clipboard copy, code paste/link navigation, auth, explicit verification/acceptance, refresh/focus/reload, invitation-bound relogin/replay, and workspace/data isolation. Screenshots and request lists: `.omo/evidence/st_01a0869f/browser/`. Manual fixture/results/screenshot: `.omo/evidence/st_01a0869f/manual*`. Its deliberately limited reader role cannot read the default dashboard; the selected company and membership assertions succeeded, and allowed project reads are covered by the eight-case suite.

One intermediate browser run exited 1 because the new prior-project assertion incorrectly expected PG's `__id` on SQLite rows (`4bf5882c-fee8-4cdc-a50e-e860084d99be/result.json`). The harness now asserts each store's actual ID field; no product behavior or test was disabled. The initial manual harness import failed before fixture startup (`e2f8fd30-558b-4988-bd04-03a1df9fc92a/result.json`); its local Vite import was corrected. Successful fixtures closed their owned browsers, servers, pools, and disposable clusters; runner results confirm temporary removal.

Diagnostics were requested for both source trees and test/script trees, but `typescript-language-server` is not installed. TypeScript build, Node syntax checks for all 13 changed JS/MJS files, and `git diff --check` passed. Existing Vite large-chunk warning remains. Native Web Share delivery and external messages/email were not exercised or sent. Orca screenshot capture was unavailable; accessibility actions and Playwright's browser screenshots supplied the manual evidence.

### Integration delta owned by this continuation

Edited inherited files: `backend/src/controllers/auth.controller.js`, `backend/tests/invitation-sharing-native.integration.mjs`, `frontend/scripts/invitation-sharing.e2e.mjs`, `frontend/scripts/auth-transition.e2e.mjs`, `frontend/src/pages/InvitationsPage.tsx`, `frontend/src/screens/OrgChartScreen.tsx`, `frontend/src/screens/members/InvitationSharingPanel.tsx`, `frontend/src/services/auth.ts`, and this handoff. Newly modified tracked files: `frontend/src/pages/LoginPage.tsx`, `frontend/scripts/auth-transition.test.mjs`.

Integrate the complete **26-file** changed/untracked set listed below together, not only this continuation's delta. Base remains `4affb0f597dff66b27191a586ffe83eb4d14fef4` on `fix/invite-code-sharing`. The reproduction commands below remain current. No new DDL is required; retain the listed existing PG migration prerequisites. No integration or production deployment has been performed.

## Earlier implementation history - st_01a08665

## DoneClaim

Implemented and verified in the owned `fix/invite-code-sharing` worktree at
`D:/00_정리파일/PERP-wt/invite-code-sharing`, based on main
`4affb0f597dff66b27191a586ffe83eb4d14fef4`. Not committed, pushed, merged, or copied into main.

- `/members` and `/org-chart` use the existing OrgChartScreen override. Its invitation panel creates a recipient-targeted seven-day invite with server-filtered role choices, displays the existing opaque token and a link, copies either through Clipboard, and offers Web Share where supported. It explicitly says email is not automatically sent. Pending invitations can be revoked. Recruitment directs its recipient to the same sharing form.
- Signed-out `/invitations` accepts pasted codes or links and preserves the token through login/signup. Both existing SQLite base64url tokens and PG UUID tokens are recognized. Signup with a legacy-format invitation creates the account in the legacy store; signup never consumes the invite. Receiver verification/acceptance selects the authenticated store, not a company header or email shortcut.
- PG create/revoke use the existing company role mutation lock and current delegation rules. Acceptance uses that same company lock, rechecks the inviter's current membership/permissions and actual company role IDs, and atomically writes membership, grants, token consumption, and audit. SQLite also checks recipient during verification and supports safe recipient-only acceptance replay. Replay never restores removed membership or grants.
- Sharing means normal, server-backed organization reads with existing grants. Project/task and generic resources refetch on focus; normal API reads bypass browser cache. Refresh, page reload, workspace lookup, and relogin see current data. No generic realtime broker or private-data synchronization was added.
- `InviteRespondPage` remains the separate reservation RSVP surface at `/reserve/invite/:token`; it is not an organization invitation.

## Main integration

Apply the complete changed/new file set below together after review. AppShell is untouched.
Optional popup entry: link **초대 코드 입력** to `/invitations`. Sender entry already exists on `/members`.
No new DDL or migration version allocation is required. Existing PG installations need their already-shipped v5 memberships, v7 roles, original `perp_additions_v8.sql` invitation table, v10 organization audit/revision, and v11 role version migrations, as required by these existing surfaces. No operating database was inspected or modified. Old PG invitations containing symbolic role names rather than actual company role IDs are not promoted automatically; regenerate them with approved role choices.

### Production paths

- `backend/src/controllers/auth.controller.js`
- `backend/src/controllers/members.controller.js`
- `backend/src/controllers/pgModules.controller.js`
- `backend/src/controllers/pgInvitations.controller.js` (new)
- `backend/src/routes/members.routes.js`
- `backend/src/routes/pgAuth.routes.js`
- `backend/src/utils/invitation-token.js` (new)
- `frontend/src/hooks/useResource.ts`
- `frontend/src/pages/InvitationsPage.tsx`
- `frontend/src/pages/LoginPage.tsx`
- `frontend/src/pages/SignupPage.tsx`
- `frontend/src/screens/OrgChartScreen.tsx`
- `frontend/src/screens/ProjectTaskScreen.tsx`
- `frontend/src/screens/members/InvitationSharingPanel.tsx` (new)
- `frontend/src/screens/members/invitation-sharing.css` (new)
- `frontend/src/screens/recruitment/PipelinePanel.tsx`
- `frontend/src/services/api.ts`
- `frontend/src/services/auth.ts`
- `frontend/src/services/authTransition.ts`

### Tests and documentation

- `backend/tests/invitation-sharing.test.js` (new)
- `backend/tests/invitation-sharing-native.integration.mjs` (new)
- `frontend/scripts/invitation-sharing.e2e.mjs` (new)
- `frontend/scripts/auth-return.test.mjs`
- `frontend/scripts/auth-transition.e2e.mjs`
- `frontend/scripts/auth-transition.test.mjs`
- `docs/invitation-sharing-handoff.md` (new)

## Verification evidence

Evidence is local under this worktree's ignored `.omo/evidence` directory.

- Initial failing tests: `.omo/evidence/deadline-runs/0f844b7e-1171-42f1-87bb-7ab44f666390/result.json`. PG verification was 404; legacy wrong-recipient verification incorrectly returned `ok`.
- Final related tests: **104 passed, 0 failed/skipped**, including real isolated SQLite and PostgreSQL **18.6**, wrong recipient/company/role, expiry, revoked/replayed tokens, current inviter permission changes, rollback on injected audit failure, scoped private API keys and private notes, existing role/security tests, and auth transition tests. `.omo/evidence/deadline-runs/f1ddd2ae-7d68-4ecf-9e0e-b0b99f290639/result.json`. Intentional audit-failure server logs are assertions of rollback, not failing tests.
- Production TypeScript/Vite build: `.omo/evidence/deadline-runs/7843d814-30e0-466d-8c34-ce9374a5add4/result.json`. Existing large-bundle warning remains. Node syntax checks passed for all 12 changed JS/MJS files; `git diff --check` passed. LSP is unavailable (`typescript-language-server` not installed), so no LSP-clean claim is made.
- Chrome sender create/copy, receiver signup/accept and shared-data refresh/focus/reload/relogin/workspace: **all four SQLite/PG x 375/1280 cases passed**, with actual HTTP/database access and synthetic accounts. `.omo/evidence/deadline-runs/c6e3d978-67a4-4ef8-a220-69f74035632a/result.json`; screenshots and request records: `.omo/evidence/st_01a08665/browser/`. Native Web Share chooser delivery is not exercised (no actual messages sent); real Clipboard copy and pasted/opened links are exercised.
- Existing auth-transition Chrome suite: **10 scenarios passed**, including forced-password continuation, workspace outages, invalid invitations, and malicious next rejection. `.omo/evidence/deadline-runs/a865d1d9-06c1-48df-b43f-85d43555f17d/result.json`; artifacts remain under the existing suite's `.omo/evidence/st_01a08625/browser/` directory inside this owned worktree.

Reproduce using the isolated runner (replace the binary path only if needed):

```text
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node --test backend/tests/invitation-sharing.test.js backend/tests/invitation-sharing-native.integration.mjs backend/tests/member-provisioning-security.test.js backend/tests/custom-role-settings.test.js backend/tests/identity-lifecycle.test.js backend/tests/pg-custom-role-settings.test.js backend/tests/pg-agent-api-key.test.js frontend/scripts/auth-return.test.mjs frontend/scripts/auth-transition.test.mjs
node scripts/run_deadline_isolated.mjs npm run build
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node frontend/scripts/invitation-sharing.e2e.mjs
node scripts/run_deadline_isolated.mjs --pg-bin C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin node frontend/scripts/auth-transition.e2e.mjs
```

## Cleanup and limits

Successful fixtures closed their browsers, HTTP servers, pools, and disposable PG clusters; the runner removed their temporary roots. One early browser-test harness failure left its own disposable PG cluster alive; that exact cluster was explicitly stopped with `pg_ctl -D .../deadline-run-YHqGqo/perp-daily-native-924TSv/data -m fast -w stop` and its exact temporary root was removed. No other worker worktree/process was changed. The harness was fixed to await action/response pairs together.

The worktree, its installed dependencies/build output, and evidence remain for parent review. No `.env`/secret files, operating DBs, real users, or production email/messages were used. Main integration and any commit require parent review; they are not claimed as completed here.
