import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function personalWikiRoot(mode) {
  assert.ok(['legacy', 'pg'].includes(mode));
  return mode === 'pg' ? '/pg/vault/wiki' : '/vault/wiki';
}
export function assertPersonalWikiRoute(mode, pathname) {
  const root = '/api/v1' + personalWikiRoot(mode);
  assert.ok(pathname === root || pathname.startsWith(root + '/'), `Non-personal Wiki request: ${pathname}`);
  return pathname.slice(root.length);
}
const evidence = fileURLToPath(new URL('../../.omo/evidence/integration-personal-wiki-complete/', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');

// This is deliberately not parameterized with f.root: that fixture root is COMPANY.
// Only setup/authority changes use the fixture API. Every workflow mutation below
// is made by a shipped control; no transaction-created jobs/drafts/publications.
export async function personalWikiScenario({ f, mode, open, arm, done, after, capture }) {
  const root = personalWikiRoot(mode), apiRoot = '/api/v1' + root;
  assert.notEqual(root, f.root);
  const proof = { mode, scope: 'personal', root, status: 'running', checks: [], network: [], actions: [], routeCounts: {}, identities: [], screens: [] };
  const contexts = [], pendingResponses = [], violations = [];
  let owner, page, source, note, job, change, published, manual, rejectedId, selectedOrg;
  const text = '한글😀\r\n같은 구절\r\n같은 구절';
  const title = '한글 TASK28_PERSONAL_PRIVATE';
  const edited = 'TASK28-PERSONAL-MANUAL 사용자 보존 본문';
  const api = (suffix, method = 'GET', body, status = 200, actor = owner) => f.api.request(actor, root + suffix, method, body, status);
  function observe(label) {
    return page => {
      page.on('request', request => {
        const url = new URL(request.url());
        if (!/\/wiki(?:\/|$)/.test(url.pathname)) return;
        try { assertPersonalWikiRoute(mode, url.pathname); } catch (error) { violations.push(error.message); }
        const route = url.pathname + url.search;
        proof.network.push({ event: 'request', actor: label, method: request.method(), route, org: request.headers()['x-org-id'], hasBearer: !!request.headers().authorization, body: request.postDataJSON() });
        if (label === 'owner') { const key = request.method() + ' ' + url.pathname; proof.routeCounts[key] = (proof.routeCounts[key] ?? 0) + 1; }
      });
      page.on('response', response => {
        const url = new URL(response.url());
        if (!/\/wiki(?:\/|$)/.test(url.pathname)) return;
        const record = { event: 'response', actor: label, method: response.request().method(), route: url.pathname + url.search, status: response.status() };
        proof.network.push(record);
        if (!url.pathname.endsWith('/events')) pendingResponses.push(response.body().then(body => { record.sha256 = sha(body); }, error => { record.bodyUnavailable = error.message; }));
      });
      page.on('requestfailed', request => {
        if (/\/wiki(?:\/|$)/.test(new URL(request.url()).pathname)) proof.network.push({ event: 'requestfailed', actor: label, route: new URL(request.url()).pathname, error: request.failure()?.errorText });
      });
    };
  }
  async function ui(suffix, method, trigger, status = 200, target = page) {
    const received = target.waitForResponse(r => new URL(r.url()).pathname === apiRoot + suffix && r.request().method() === method);
    await trigger();
    const response = await received;
    assert.equal(response.status(), status, `${method} ${root + suffix}`);
    const body = await response.json();
    proof.actions.push({ method, route: new URL(response.url()).pathname, status, request: response.request().postDataJSON(), response: body });
    return body;
  }
  async function member(name, role) {
    const email = `${name}-${mode}@example.invalid`;
    if (mode === 'pg') {
      const user = await f.api.request(f.a, '/pg/members', 'POST', { email, name, password: 'password-1234' }, 201);
      const login = await f.api.request(null, '/pg/auth/login', 'POST', { email, password: 'password-1234' });
      const actor = { token: login.token, userId: String(user.id), orgId: f.a.orgId };
      await assign(actor, role); return actor;
    }
    const invite = await f.api.request(f.a, '/members/invites', 'POST', { email, roles: [role.key] }, 201);
    const signup = await f.api.request(null, '/auth/signup', 'POST', { email, name, password: 'password-1234', invitation_token: invite.token }, 201);
    return { token: signup.access_token, userId: signup.user.id, orgId: f.a.orgId };
  }
  async function assign(actor, role) {
    const member = (await f.api.request(f.a, '/settings/members')).items.find(m => m.user_id === actor.userId);
    assert.ok(member);
    await f.api.request(f.a, `/settings/members/${member.membership_id}/roles`, 'PUT', { roles: [role.key], expected_roles_version: member.roles_version });
  }
  async function identity(actor = owner) {
    const wiki = (await api('', 'GET', undefined, 200, actor)).wiki;
    assert.equal(wiki.scope, 'personal'); assert.equal(wiki.store, mode); assert.equal(wiki.owner_id, owner.userId);
    assert.equal(wiki.company_id, mode === 'pg' ? null : owner.orgId);
    if (proof.identities.length) assert.equal(wiki.id, proof.identities[0].id);
    proof.identities.push(wiki); return wiki;
  }
  async function loaded() { await arm(page, '[data-wiki-workspace][data-loading="false"]'); await done(page); }
  async function reopen(kind, id) {
    const details = page.locator('[data-wiki-workspace] details').filter({ has: page.getByLabel('저장한 작업 ID', { exact: true }) });
    if (await details.getAttribute('open') === null) await details.locator('summary').click();
    await page.getByLabel(kind === 'job' ? '저장한 작업 ID' : '저장한 초안 ID', { exact: true }).fill(id);
    await after(page, kind === 'job' ? `[data-job-id="${id}"][data-job-state="succeeded"]` : `[data-review-id="${id}"]`, () => page.getByRole('button', { name: kind === 'job' ? '인가된 작업 다시 열기' : '인가된 초안 다시 열기' }).click());
  }
  async function selectPublished(revision) {
    await after(page, `.wiki-revision[data-revision-id="${revision}"]`, () => page.locator(`[data-page-revision-id="${revision}"]`).click());
  }
  async function publish(review) {
    assert.equal(await page.locator('[data-review-digest]').textContent(), review.manifest_hash);
    assert.equal(await page.getByRole('button', { name: '명시적으로 게시', exact: true }).isDisabled(), true);
    await page.getByLabel('이 정확한 변경 묶음 게시 확인').check();
    const receipt = await ui(`/change-sets/${review.id}/publish`, 'POST', () => page.getByRole('button', { name: '명시적으로 게시', exact: true }).click());
    assert.deepEqual(proof.actions.at(-1).request, { manifest_hash: review.manifest_hash, confirmed: true });
    assert.equal(receipt.manifest_hash, review.manifest_hash); await loaded(); return receipt.result_json.pages[0];
  }
  async function snapshot(name) { await capture(page, name); proof.screens.push(...[375, 768, 1280].map(width => `${mode}-${name}-${width}.png`)); }
  async function close(error) {
    if (error) { proof.status = 'failed'; proof.error = { message: error.message, stack: error.stack }; }
    for (const context of contexts) await context.close();
    contexts.length = 0;
    await Promise.all(pendingResponses);
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, `${mode}-personal.json`), JSON.stringify(proof, null, 2));
  }
  try {
    const role = await f.api.request(f.a, '/settings/roles', 'POST', { name: 'Task28 private owner', scope: 'all', permissions: ['menu.home', 'menu.vault', 'menu.vault_graph', 'agent.chat'] }, 201);
    const denied = await f.api.request(f.a, '/settings/roles', 'POST', { name: 'Task28 private read withdrawn', scope: 'all', permissions: ['menu.home'] }, 201);
    owner = await member('task28-personal-owner', role); const wrong = await member('task28-personal-wrong', role); selectedOrg = owner.orgId;
    proof.ownerId = owner.userId; proof.wrongOwnerId = wrong.userId; proof.adminId = f.a.userId;
    assert.notEqual(owner.userId, f.a.userId); assert.notEqual(owner.userId, wrong.userId);
    note = await f.api.request(owner, f.prefix + '/vault/notes', 'POST', { title: 'Task28 private owned note', content: text }, 201);
    const opened = await open(owner, '/vault/graph', observe('owner')); page = opened.page; contexts.push(opened.context);
    await loaded(); assert.equal((await api('/pages')).items.length, 0);
    const noteRead = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${f.prefix}/vault/notes/${note.id}`);
    await page.getByLabel('그래프 노트 선택').selectOption(note.id); assert.equal((await noteRead).status(), 200);
    source = await ui('/sources', 'POST', () => page.getByRole('button', { name: '선택 원본 등록', exact: true }).click(), 201);
    await arm(page, '[data-wiki-workspace][data-source-count="1"][data-loading="false"]'); await done(page); await identity();
    const exactSource = `/sources/${source.id}/revisions/${source.current_revision_id}`;
    const original = await api(exactSource);
    assert.equal(original.source_identity.store, mode); assert.equal(original.source_identity.owner, owner.userId);
    assert.equal(original.content, text); assert.equal(original.content_sha256, sha(text));
    assert.equal(await page.locator('[data-wiki-workspace]').getAttribute('data-page-count'), '0');
    await snapshot('personal-raw-zero');
    await page.getByLabel('위키 조사 질문').fill(title);
    await page.getByLabel('게시 위키 검색', { exact: true }).uncheck();
    await arm(page, '[data-job-state="succeeded"]');
    job = await ui('/jobs', 'POST', () => page.getByRole('button', { name: '원본 기반 조사', exact: true }).click(), 202);
    await done(page);
    const durable = await api(`/jobs/${job.id}`);
    assert.equal(durable.result.review_state, 'unreviewed'); assert.equal(durable.result.citation_validation, 'anchors_valid');
    assert.equal(durable.result.retrieval_coverage.raw, true); assert.equal(durable.result.retrieval_coverage.published_wiki, false);
    assert.deepEqual(durable.result.retrieval_coverage.selected_revision_ids, [source.current_revision_id]);
    assert.equal(durable.result.citations[0].revision_id, source.current_revision_id);
    assert.equal((await api('/pages')).items.length, 0);
    await page.reload({ waitUntil: 'domcontentloaded' }); await loaded(); await reopen('job', job.id);
    assert.deepEqual((await api(`/jobs/${job.id}`)).result, durable.result);
    await after(page, `.wiki-revision[data-revision-id="${source.current_revision_id}"] mark`, () => page.locator(`[data-job-id="${job.id}"] .wiki-citations button`).first().click());
    assert.equal(await page.locator('.wiki-revision mark').textContent(), text);
    await snapshot('personal-citation');
    const draft = await ui(`/jobs/${job.id}/draft`, 'POST', () => page.getByRole('button', { name: '이 결과를 검토 초안으로 보관', exact: true }).click());
    await arm(page, `[data-review-id="${draft.change_set_id}"]`); await done(page);
    change = await api(`/change-sets/${draft.change_set_id}`);
    assert.equal(draft.result_revision_id, durable.result.result_revision_id);
    assert.deepEqual(change.proposed_revisions[0].provenance.exact_result, durable.result);
    assert.equal(change.proposed_revisions[0].markdown, durable.result.answer_md);
    await page.reload({ waitUntil: 'domcontentloaded' }); await loaded(); await reopen('draft', change.id);
    assert.equal((await api('/pages')).items.length, 0);
    published = await publish(change);
    proof.checks.push('real private owner registers own note; personal raw-only query at pages0; durable unreviewed result and exact UTF8 citation; reload job and immutable exact-result draft; unchecked digest publish disabled; real checkbox publishes exact digest');

    // Same-company admin and another authorized vault reader cannot substitute
    // their identity, even for a known immutable source/job/draft/page ID.
    for (const [label, actor] of [['wrong-owner', wrong], ['admin', f.a]]) {
      await api(exactSource, 'GET', undefined, 404, actor);
      await api(`/jobs/${job.id}`, 'GET', undefined, 404, actor);
      await api(`/change-sets/${change.id}`, 'GET', undefined, 404, actor);
      await api(`/pages/${published.id}?revision=${published.revision_id}`, 'GET', undefined, 404, actor);
      await api('/sources', 'POST', { kind: 'record', origin_kind: 'note', origin_id: note.id, version: note.version }, 404, actor);
      const other = await open(actor, '/vault/graph', observe(label)); contexts.push(other.context);
      await other.page.getByText('저장한 작업·초안 다시 열기', { exact: true }).click();
      await other.page.getByLabel('저장한 작업 ID', { exact: true }).fill(job.id);
      await ui(`/jobs/${job.id}`, 'GET', () => other.page.getByRole('button', { name: '인가된 작업 다시 열기' }).click(), 404, other.page);
      await arm(other.page, '[data-wiki-workspace][data-loading="false"]'); await done(other.page);
      assert.equal(await other.page.locator('[data-job-id],[data-review-id],.wiki-revision').count(), 0);
      assert.ok(!(await other.page.locator('[data-wiki-workspace]').innerText()).includes(title));
      await other.context.close(); contexts.splice(contexts.indexOf(other.context), 1);
    }
    proof.checks.push('authorized same-company wrong owner and administrator denied original registration, fixed revision, private job, draft and published history; actual UI job reopening denied404');
    if (mode === 'pg') {
      const second = await f.api.request(owner, '/pg/companies', 'POST', { name: 'Task28 private pipeline second company', modules: ['documents', 'agent', 'projects'], features: [], departments: [] }, 201);
      selectedOrg = second.org_id;
      const switched = page.waitForResponse(r => new URL(r.url()).pathname === apiRoot && r.request().headers()['x-org-id'] === selectedOrg);
      await page.evaluate(async orgId => { const { sessionStore } = await import('/src/store/session.ts'); sessionStore.patch({ orgId }); }, selectedOrg);
      const switchedWiki = (await (await switched).json()).wiki;
      assert.equal(switchedWiki.id, proof.identities[0].id); await loaded();
      await identity({ ...owner, orgId: selectedOrg });
      const fixed = await api(exactSource, 'GET', undefined, 200, { ...owner, orgId: selectedOrg });
      assert.equal(fixed.source_identity.owner, owner.userId); assert.equal(fixed.source_identity.company, null);
      await reopen('job', job.id); await reopen('draft', change.id);
      proof.checks.push('PG real company session switch preserves the same personal wiki/source/job/draft/page identity, owner and null company');
    }
    await page.reload({ waitUntil: 'domcontentloaded' }); await loaded(); await selectPublished(published.revision_id);
    await page.getByRole('button', { name: '위키 수동 편집', exact: true }).click();
    await page.getByLabel('위키 편집 본문').fill(edited);
    const manualDraft = await ui(`/pages/${published.id}/change-sets`, 'POST', () => page.getByRole('button', { name: '수동 변경을 검토 초안으로 저장' }).click(), 201);
    await arm(page, `[data-review-id="${manualDraft.id}"]`); await done(page);
    manual = await publish(await api(`/change-sets/${manualDraft.id}`));
    assert.notEqual(manual.revision_id, published.revision_id);
    await page.reload({ waitUntil: 'domcontentloaded' }); await loaded(); await selectPublished(manual.revision_id);
    assert.ok((await page.locator('.wiki-revision').innerText()).includes(edited));
    const history = await ui(`/pages/${published.id}/history`, 'GET', () => page.getByRole('button', { name: '게시 이력 보기', exact: true }).click());
    assert.deepEqual(new Set(history.items.map(r => r.id)), new Set([published.revision_id, manual.revision_id]));
    const v1 = history.items.find(r => r.id === published.revision_id);
    await after(page, `.wiki-revision[data-revision-id="${published.revision_id}"]`, () => page.getByRole('button', { name: `v${v1.version} · ${v1.title} · ${v1.freshness}`, exact: true }).click());
    assert.ok((await page.locator('.wiki-revision').innerText()).includes(durable.result.answer_md));
    assert.ok(!(await page.locator('.wiki-revision').innerText()).includes(edited));
    // Force reauthorization to overlap the existing history citation click.
    // Real HTTP responses are held, not replaced; a refresh must not restore
    // the previously selected page over the newly verified source citation.
    const citationHeld = Promise.withResolvers(), citationRelease = Promise.withResolvers();
    const previousHeld = Promise.withResolvers(), previousRelease = Promise.withResolvers();
    const routeFinished = [];
    const sourceUrl = url => url.pathname === apiRoot + exactSource;
    const previousUrl = url => url.pathname === apiRoot + `/pages/${published.id}` && url.searchParams.get('revision') === published.revision_id;
    const hold = (held, release) => async route => {
      const finished = Promise.withResolvers(); routeFinished.push(finished.promise);
      try { const response = await route.fetch(); held.resolve(); await release.promise; await route.fulfill({ response }); finished.resolve(); }
      catch (error) { held.reject(error); finished.reject(error); }
    };
    const bound = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('citation refresh deadline')), 20000); })]).finally(() => clearTimeout(timer)); };
    await page.context().route(sourceUrl, hold(citationHeld, citationRelease), { times: 1 });
    await page.context().route(previousUrl, hold(previousHeld, previousRelease), { times: 1 });
    try {
      await page.locator('.wiki-revision .wiki-citations button').first().click(); await bound(citationHeld.promise);
      await after(page, '[data-wiki-workspace][data-loading="true"]', () => page.evaluate(() => window.dispatchEvent(new Event('orbitflow:access-changed'))));
      await arm(page, '[data-wiki-workspace][data-loading="false"]'); const refreshed = done(page);
      await bound(Promise.race([previousHeld.promise, refreshed]));
      await after(page, `.wiki-revision[data-revision-id="${source.current_revision_id}"] mark`, async () => citationRelease.resolve());
      previousRelease.resolve(); await bound(refreshed);
      assert.equal(await page.locator('.wiki-revision').getAttribute('data-revision-id'), source.current_revision_id);
      assert.equal(await page.locator('.wiki-revision mark').textContent(), text);
      proof.checks.push('reauthorization overlapping history citation cannot restore the old selected page over the exact verified source revision');
    } finally {
      citationRelease.resolve(); previousRelease.resolve();
      await page.context().unroute(sourceUrl); await page.context().unroute(previousUrl);
      await bound(Promise.all(routeFinished));
    }
    await selectPublished(manual.revision_id);
    await page.getByRole('button', { name: '위키 수동 편집', exact: true }).click(); await page.getByLabel('위키 편집 본문').fill('TASK28_PERSONAL_REJECTED_NOT_PUBLISHED');
    const rejected = await ui(`/pages/${published.id}/change-sets`, 'POST', () => page.getByRole('button', { name: '수동 변경을 검토 초안으로 저장' }).click(), 201); rejectedId = rejected.id;
    await arm(page, `[data-review-id="${rejectedId}"]`); await done(page);
    const rejectedReview = await api(`/change-sets/${rejectedId}`);
    await ui(`/change-sets/${rejectedId}/reject`, 'POST', () => page.getByRole('button', { name: '이 묶음 거절' }).click());
    assert.deepEqual(proof.actions.at(-1).request, { manifest_hash: rejectedReview.manifest_hash });
    assert.equal((await api(`/change-sets/${rejectedId}`)).state, 'rejected');
    assert.equal((await api(`/pages/${published.id}`)).id, manual.revision_id);
    assert.equal((await f.api.request(owner, `${f.prefix}/vault/notes/${note.id}`)).content, text);
    await snapshot('personal-history-manual-reject');
    proof.checks.push('personal manual edit -> exact digest republish; reload edited head; real history click opens old immutable version and its exact source citation; explicit digest rejection leaves head and original note unchanged');

    return { proof, close, async finish({ restarted, ipc }) {
      try {
        // The parent has moved the real Vite proxy to a new backend OS process.
        const stream = ipc(restarted, 'stream-open', value => value.url === apiRoot + '/events');
        await page.reload({ waitUntil: 'domcontentloaded' }); const initial = await stream;
        assert.equal(initial.hasBearer, true); await loaded(); await identity({ ...owner, orgId: selectedOrg });
        await reopen('job', job.id); await reopen('draft', rejectedId); await selectPublished(manual.revision_id);
        assert.ok((await page.locator('.wiki-revision').innerText()).includes(edited));
        const reconnected = ipc(restarted, 'stream-open', value => value.url === apiRoot + '/events' && Number(value.cursor) > 0);
        restarted.send({ type: 'close-streams' }); const next = await reconnected;
        assert.equal(next.hasBearer, true); assert.ok(!next.url.includes('token')); proof.reconnect = { pid: restarted.pid, initial, next };
        await loaded();
        proof.checks.push('new backend OS process reopens actual personal durable job/rejected draft/manual head; authenticated personal SSE normal EOF reconnect has exact personal URL and positive authorized cursor');

        async function assertEmpty() {
          await arm(page, '[data-wiki-workspace][data-loading="false"][data-source-count="0"][data-page-count="0"]'); await done(page);
          assert.equal(await page.locator('[data-job-id],[data-review-id],.wiki-revision').count(), 0);
          const visible = await page.locator('main').innerText(); assert.ok(!visible.includes(title)); assert.ok(!visible.includes(edited));
        }
        async function restore() {
          await page.reload({ waitUntil: 'domcontentloaded' }); await loaded();
          await reopen('job', job.id); await reopen('draft', rejectedId); await selectPublished(manual.revision_id);
          assert.ok((await page.locator('.wiki-revision').innerText()).includes(edited));
        }
        // Personal PG has no company-role read gate: its read authority is the
        // account's approval. SQLite's is menu.vault + agent.chat membership.
        if (mode === 'pg') await f.sql("UPDATE auth.users SET approval_status='pending' WHERE id=$1", [owner.userId]);
        else await assign(owner, denied);
        const readStatus = mode === 'pg' ? 401 : 403;
        await ui('', 'GET', () => page.getByRole('button', { name: '다시 연결·새로고침' }).click(), readStatus); await assertEmpty();
        await api(`/jobs/${job.id}`, 'GET', undefined, readStatus); await api(`/pages/${published.id}`, 'GET', undefined, readStatus);
        await snapshot('personal-read-withdrawn');
        if (mode === 'pg') await f.sql("UPDATE auth.users SET approval_status='approved' WHERE id=$1", [owner.userId]); else await assign(owner, role);
        await restore();
        proof.checks.push('actual personal read authority withdrawn (SQLite vault grants / PG account approval): reconnect hides source/job/draft/page/graph/body and HTTP reads denied at the store auth boundary; restore reauthorizes immutable state');

        if (mode === 'pg') await f.sql("UPDATE auth.users SET account_status='suspended' WHERE id=$1", [owner.userId]);
        else await f.sql("UPDATE app_user SET auth_status='disabled' WHERE id=?", [owner.userId]);
        // Both authentication middlewares reject a suspended session before Wiki authorization.
        await ui('', 'GET', () => page.getByRole('button', { name: '다시 연결·새로고침' }).click(), 401); await assertEmpty();
        await api(`/jobs/${job.id}`, 'GET', undefined, 401);
        await snapshot('personal-actor-withdrawn');
        if (mode === 'pg') await f.sql("UPDATE auth.users SET account_status='active' WHERE id=$1", [owner.userId]);
        else await f.sql("UPDATE app_user SET auth_status='active' WHERE id=?", [owner.userId]);
        await restore();
        proof.checks.push('actual actor account suspension clears rendered personal private state and denies job read; restoring actor recovers unchanged manual publication');

        // A second real same-owner UI withdraws the source while an authorized
        // old job HTTP response is held. Subscribe before each trigger, never poll.
        const revoker = await open({ ...owner, orgId: selectedOrg }, '/vault/graph', observe('owner-withdrawer')); contexts.push(revoker.context);
        const held = Promise.withResolvers(), release = Promise.withResolvers(), finished = Promise.withResolvers();
        await page.context().route(`**${apiRoot}/jobs/${job.id}`, async route => {
          try { const response = await route.fetch(); held.resolve(); await release.promise; await route.fulfill({ response }); finished.resolve(); }
          catch (error) { finished.reject(error); }
        }, { times: 1 });
        const bounded = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('personal delayed response deadline')), 20000); })]).finally(() => clearTimeout(timer)); };
        try {
          await page.getByRole('button', { name: '다시 연결·새로고침' }).click(); await bounded(held.promise);
          await ui(`/sources/${source.id}`, 'DELETE', () => revoker.page.getByRole('button', { name: '등록 철회', exact: true }).click(), 200, revoker.page);
          // Both browser contexts reach the restarted server. Its real source
          // invalidation and the explicit reconnect reauthorize the old response.
        } finally { release.resolve(); }
        await bounded(finished.promise);
        await page.getByRole('button', { name: '다시 연결·새로고침' }).click(); await assertEmpty();
        await api(exactSource, 'GET', undefined, 404);
        await api(`/pages/${published.id}?revision=${published.revision_id}`, 'GET', undefined, 404);
        assert.equal((await api('/pages')).items.length, 0);
        assert.equal((await f.api.request(owner, `${f.prefix}/vault/notes/${note.id}`)).content, text);
        await snapshot('personal-source-withdrawn');
        proof.checks.push('actual personal UI source withdrawal plus delayed real job response and reconnect removes private result/review/published title/body/graph/history; original note remains byte-identical');
        const switched = page.waitForResponse(r => new URL(r.url()).pathname === apiRoot && r.request().headers().authorization === `Bearer ${wrong.token}`);
        await page.evaluate(async actor => { const { sessionStore } = await import('/src/store/session.ts'); sessionStore.patch({ token: actor.token, orgId: actor.orgId }); }, { token: wrong.token, orgId: wrong.orgId });
        await switched; await assertEmpty();
        proof.checks.push('real personal actor session switch cannot restore former owner state');
        assert.deepEqual(violations, []);
        const count = (method, suffix) => proof.routeCounts[method + ' ' + apiRoot + suffix] ?? 0;
        assert.equal(count('POST', '/sources'), 1); assert.equal(count('POST', '/jobs'), 1);
        assert.equal(count('POST', `/jobs/${job.id}/draft`), 1);
        assert.equal(count('POST', `/change-sets/${change.id}/publish`), 1);
        assert.equal(count('POST', `/pages/${published.id}/change-sets`), 2);
        assert.equal(count('POST', `/change-sets/${manualDraft.id}/publish`), 1);
        assert.equal(count('POST', `/change-sets/${rejectedId}/reject`), 1);
        for (const suffix of ['', '/events', '/pages', `/jobs/${job.id}`, `/change-sets/${change.id}`, `/pages/${published.id}/history`, exactSource]) assert.ok(count('GET', suffix) > 0, suffix);
        assert.equal(proof.network.filter(r => r.event === 'request' && r.actor === 'owner-withdrawer' && r.method === 'DELETE' && r.route === apiRoot + `/sources/${source.id}`).length, 1);
        proof.ids = { note: note.id, source: source.id, sourceRevision: source.current_revision_id, job: job.id, draft: change.id, page: published.id, firstRevision: published.revision_id, manualDraft: manualDraft.id, manualRevision: manual.revision_id, rejectedDraft: rejectedId };
        proof.status = 'passed'; await close(); return proof;
      } catch (error) { await close(error); throw error; }
    } };
  } catch (error) { await close(error); throw error; }
}
