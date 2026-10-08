import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setupJobs } from './deadline-wiki-jobs-fixture.js';

// Synthetic output enters real admission/acceptance; publication and serving use authenticated HTTP.
export async function bundleScenarios(mode) {
  const f = await setupJobs(mode);
  const evidence = new URL('../../.omo/evidence/wiki-bundle-revision/', import.meta.url);
  const checks = [];
  let nativeData, engine;
  const jobs = await import('../src/services/knowledge-wiki-jobs.service.js');
  const publication = await import('../src/services/knowledge-wiki-publication.service.js');
  const tx = (write, work) => f.tx(f.context, { write }, work);
  async function request(route, body, status = 200, key = randomUUID(), actor = f.a) {
    const response = await fetch(f.api.baseUrl + f.root + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Idempotency-Key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    f.api.http.push({ method: 'POST', route: f.root + route, status: response.status, body: result });
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const page = (key, target_page_id = null, links = [], citations = [0]) => ({ key, target_page_id, kind: 'page', title: `bundle ${key}`, markdown: `bundle evidence ${key}`, index_entry: `- bundle ${key}`, citations, links });
  const link = target => ({ target, predicate: 'related', direction: 'directed', citations: [0] });
  async function draft(input, pages) {
    const admitted = await request('/jobs', input, 202);
    const lease = await jobs.claimWikiJob(f.context, admitted.id, 'bundle-fixture', { model_version: 'synthetic-bundle-not-inference' });
    const result = await jobs.acceptWikiResult(f.context, admitted.id, lease, { model_version: 'synthetic-bundle-not-inference', output: { answer_md: null, citations: [0], uncertainty: [], pages, suggestions: [] } });
    return f.api.request(f.a, f.root + '/change-sets/' + result.change_set_id);
  }
  const publish = (d, status = 200, key = randomUUID(), hash = d.manifest_hash) => request(`/change-sets/${d.id}/publish`, { manifest_hash: hash, confirmed: true }, status, key);
  const ingest = (sources, targets = []) => ({ operation: 'ingest', source_revision_ids: sources.map(s => s.current_revision_id), target_base_versions: targets.map(p => ({ page_id: p.id, version: p.version, published_head_id: p.revision_id })) });
  const lint = receipt => ({ operation: 'lint', page_revision_ids: receipt.result_json.page_revision_ids });
  async function projections(expected, actor = f.a) {
    const ids = expected.map(p => p.revision_id).sort();
    const listed = await f.api.request(actor, f.root + '/pages');
    assert.deepEqual(listed.items.map(p => p.revision_id).sort(), ids, 'current page list retains the whole publication');
    const graph = await f.api.request(actor, f.root + '/graph');
    assert.deepEqual(graph.nodes.filter(n => n.page_id).map(n => n.revision_id).sort(), ids);
    for (const p of expected) assert.equal((await f.api.request(actor, f.root + '/pages/' + p.id)).freshness, 'current');
    const q = await request('/jobs', { operation: 'query', question: 'bundle', retrieval: { raw: false, published_wiki: true } }, 202, randomUUID(), actor);
    const selected = await tx(false, function*(t) { return JSON.parse((yield* t.get('job', q.id)).source_vector_json).coverage.selected_revision_ids; });
    assert.deepEqual(selected.sort(), ids, 'actual query admission selects current bundle revisions');
    await f.api.request(actor, f.root + '/jobs/' + q.id + '/cancel', 'POST', {});
    return graph;
  }
  const snapshot = () => tx(false, function*(t) {
    const value = { wiki: t.wiki };
    for (const table of ['page', 'page_revision', 'dependency', 'publication', 'change_set', 'event']) value[table] = yield* t.all(table);
    return value;
  });
  try {
    if (f.native) {
      engine = (await f.native.pool.query('SELECT version()')).rows[0].version;
      nativeData = (await f.native.pool.query('SHOW data_directory')).rows[0].data_directory;
      assert.match(engine, /PostgreSQL 18/);
    }
    const raw = await f.upload('bundle public evidence');
    const uncited = await f.upload('bundle uncited restricted evidence');
    const firstDraft = await draft(ingest([raw, uncited]), [page('a', null, [link('b')]), page('b', null, [link('a')])]);
    const first = await publish(firstDraft);
    await projections(first.result_json.pages);
    const revisionDraft = await draft(lint(first), first.result_json.pages.map((p, i) => page('v2-' + i, p.id, [link('v2-' + (1 - i))], [i])));
    const frozen = await tx(false, function*(t) { return yield* t.get('change_set', revisionDraft.id); });
    const key = randomUUID();
    let revised = await publish(revisionDraft, 200, key);
    assert.deepEqual(revised.result_json.pages.map(p => p.version), [2, 2]);
    const graph = await projections(revised.result_json.pages);
    const rows = await tx(false, function*(t) { return yield* t.all('dependency'); });
    for (const p of revised.result_json.pages) {
      const deps = rows.filter(d => d.dependent_page_revision_id === p.revision_id);
      assert.deepEqual(deps.filter(d => d.source_revision_id).map(d => d.source_revision_id).sort(), [raw.current_revision_id, uncited.current_revision_id].sort());
      assert.equal(deps.filter(d => d.page_revision_id).length, 0, 'bundle ancestry is not a circular live dependency');
      const exact = await f.api.request(f.a, `${f.root}/pages/${p.id}`);
      const proposal = revisionDraft.proposed_revisions.find(r => r.page_id === p.id);
      assert.deepEqual(JSON.parse(exact.citations_json), proposal.citations, 'evidence anchors remain exact old input revisions, not new-text claims');
      assert.ok(JSON.parse(exact.links_json).every(l => revised.result_json.page_revision_ids.includes(l.target_revision_id)), 'relations address the atomically published heads');
    }
    assert.equal(graph.edges.filter(e => e.type === 'ai_derived').length, 2);
    const after = await tx(false, function*(t) { return yield* t.get('change_set', revisionDraft.id); });
    for (const field of ['lineage_json', 'proposed_revisions_json', 'expected_heads_json', 'manifest_hash', 'input_manifest_hash']) assert.equal(after[field], frozen[field]);
    assert.deepEqual(await publish(revisionDraft, 200, key), revised);
    await publish(revisionDraft, 409, randomUUID(), '0'.repeat(64));
    checks.push('two-page HTTP first/update: list, graph, current reads, query; exact immutable lineage/citations; remapped relations; full uncited raw closure; digest/replay');

    // A failure after the second head write must roll back both replacements and every receipt/event.
    const rollbackDraft = await draft(lint(revised), revised.result_json.pages.map((p, i) => page('rollback-' + i, p.id)));
    const beforeRollback = await snapshot();
    const secondId = revised.result_json.pages[1].id;
    if (f.native) await f.native.pool.query(`CREATE FUNCTION knowledge.bundle_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bundle-second-head'; END $$; CREATE TRIGGER bundle_fail AFTER UPDATE ON knowledge.page FOR EACH ROW WHEN (NEW.id='${secondId}') EXECUTE FUNCTION knowledge.bundle_fail()`);
    else f.db().exec(`CREATE TRIGGER bundle_fail AFTER UPDATE ON knowledge_page WHEN NEW.id='${secondId}' BEGIN SELECT RAISE(ABORT,'bundle-second-head'); END`);
    try { await assert.rejects(() => publication.publishChangeSet(f.context, rollbackDraft.id, { manifest_hash: rollbackDraft.manifest_hash, confirmed: true }, randomUUID()), /bundle-second-head/); }
    finally {
      if (f.native) await f.native.pool.query('DROP TRIGGER bundle_fail ON knowledge.page; DROP FUNCTION knowledge.bundle_fail()');
      else f.db().exec('DROP TRIGGER bundle_fail');
    }
    assert.deepEqual(await snapshot(), beforeRollback);
    await projections(revised.result_json.pages);
    checks.push('second replacement-head write failure rolls back the complete multi-page transaction');

    // A replaced head can inherit another replaced head, not just a raw leaf.
    const partial = await publish(await draft(lint(revised), [page('partial', revised.result_json.pages[0].id)]));
    const partialHeads = [partial.result_json.pages[0], revised.result_json.pages[1]];
    await projections(partialHeads);
    revised = await publish(await draft({ operation: 'lint', page_revision_ids: partialHeads.map(p => p.revision_id) }, partialHeads.map((p, i) => page('recursive-' + i, p.id))));
    await projections(revised.result_json.pages);
    checks.push('recursive replaced-head ancestry retains raw frontier without reintroducing old sibling dependencies');

    // A separate publication's head is still a live dependency, even when uncited.
    const externalDraft = await draft(ingest([raw]), [page('external')]);
    const external = await publish(externalDraft);
    const externalHead = external.result_json.pages[0];
    const reverseExternal = await publish(await draft({ operation: 'lint', page_revision_ids: [revised.result_json.pages[0].revision_id] }, [page('reverse-external')]));
    const selfInvalidating = await draft({ operation: 'lint', page_revision_ids: [...revised.result_json.page_revision_ids, ...reverseExternal.result_json.page_revision_ids] }, revised.result_json.pages.map((p, i) => page('self-invalidating-' + i, p.id)));
    const beforeRejected = await snapshot();
    const denied = await publish(selfInvalidating, 409);
    assert.equal(denied.error.code, 'SOURCE_STALE');
    assert.deepEqual(await snapshot(), beforeRejected, 'external dependence on a replaced target rejects the entire publication');
    await projections([...revised.result_json.pages, externalHead, ...reverseExternal.result_json.pages]);
    checks.push('self-invalidating external dependency rejected atomically, never flattened or weakened');
    const withExternal = await draft({ operation: 'lint', page_revision_ids: [...revised.result_json.page_revision_ids, externalHead.revision_id] }, revised.result_json.pages.map((p, i) => page('external-input-' + i, p.id, [], [i])));
    const externalBundle = await publish(withExternal);
    await projections([...externalBundle.result_json.pages, externalHead]);
    const externalDeps = await tx(false, function*(t) { return yield* t.all('dependency'); });
    for (const p of externalBundle.result_json.pages) assert.deepEqual(externalDeps.filter(d => d.dependent_page_revision_id === p.revision_id && d.page_revision_id).map(d => d.page_revision_id), [externalHead.revision_id]);
    // Human editing an independent raw-backed page retains CAS and causes genuine external invalidation.
    const staleCAS = await draft(ingest([raw], [externalHead]), [page('loser', externalHead.id)]);
    const human = await f.api.request(f.a, `${f.root}/pages/${externalHead.id}/change-sets`, 'POST', { expected_version: 1, title: 'bundle human external', markdown: 'bundle human evidence' }, 201);
    const humanReceipt = await publish(human);
    await publish(staleCAS, 409);
    await projections(humanReceipt.result_json.pages);
    for (const p of externalBundle.result_json.pages) assert.equal((await f.api.request(f.a, `${f.root}/pages/${p.id}?revision=${p.revision_id}`)).freshness, 'stale');
    await publish(withExternal, 409);
    checks.push('external uncited revision dependencies remain live; human edit/CAS; external head change stales both dependent pages');

    // A human can edit a bundle-derived page without turning old evidence into claims about new text.
    const manualBase = await publish(await draft(ingest([raw, uncited]), [page('manual-a'), page('manual-b')]));
    const manualV2 = await publish(await draft(lint(manualBase), manualBase.result_json.pages.map((p, i) => page('manual-v2-' + i, p.id, [link('manual-v2-' + (1 - i))], [i]))));
    const manualPage = manualV2.result_json.pages[0];
    const manualBundleDraft = await f.api.request(f.a, `${f.root}/pages/${manualPage.id}/change-sets`, 'POST', { expected_version: 2, title: 'bundle human', markdown: 'bundle human updated' }, 201);
    const manualUpdated = await publish(manualBundleDraft);
    const manualCurrent = [manualUpdated.result_json.pages[0], manualV2.result_json.pages[1]];
    const manualAfter = await f.api.request(f.a, `${f.root}/pages/${manualPage.id}`);
    const manualBefore = await f.api.request(f.a, `${f.root}/pages/${manualPage.id}?revision=${manualPage.revision_id}`);
    assert.equal(manualAfter.citations_json, manualBefore.citations_json);
    assert.deepEqual(JSON.parse(manualAfter.links_json).map(l => l.citations), JSON.parse(manualBefore.links_json).map(l => l.citations));
    const manualLineage = JSON.parse(manualBundleDraft.lineage_json);
    for (const p of manualBase.result_json.pages) {
      const historical = manualLineage.inputs.find(i => i.kind === 'prior_result' && i.revision_id === p.revision_id);
      const exact = await f.api.request(f.a, `${f.root}/pages/${p.id}?revision=${p.revision_id}`);
      assert.equal(historical.supplied_text, exact.markdown);
      assert.equal(historical.supplied_sha256, exact.content_sha256);
      assert.deepEqual(historical.source_revision_ids.sort(), [raw.current_revision_id, uncited.current_revision_id].sort());
    }
    checks.push('human edit of bundle-derived V2 retains exact historical page/link anchors, full context bytes/hashes and uncited raw closure');

    // Rebuild from fresh raw is explicit; source changes still invalidate transitively through multiple publications.
    const rebuiltDraft = await draft(ingest([raw, uncited]), [page('fresh-a'), page('fresh-b')]);
    const rebuilt = await publish(rebuiltDraft);
    const rebuiltV2 = await publish(await draft(lint(rebuilt), rebuilt.result_json.pages.map((p, i) => page('fresh-v2-' + i, p.id))));
    const downstream = await publish(await draft(lint(rebuiltV2), [page('downstream')]));
    await projections([...humanReceipt.result_json.pages, ...manualCurrent, ...rebuiltV2.result_json.pages, ...downstream.result_json.pages]);
    const next = await f.api.request(f.a, `${f.root}/sources/${uncited.id}/revisions`, 'POST', { expected_version: 1, filename: 'new.md', mime: 'text/markdown', content_base64: Buffer.from('bundle changed uncited').toString('base64') }, 201);
    await projections(humanReceipt.result_json.pages);
    for (const p of [...manualCurrent, ...rebuiltV2.result_json.pages, ...downstream.result_json.pages]) assert.equal((await f.api.request(f.a, `${f.root}/pages/${p.id}?revision=${p.revision_id}`)).freshness, 'stale');
    await publish(revisionDraft, 409, key);
    await f.api.request(f.a, `${f.root}/sources/${uncited.id}`, 'DELETE', { expected_version: next.version });
    for (const p of [...revised.result_json.pages, ...manualCurrent, ...rebuiltV2.result_json.pages, ...downstream.result_json.pages]) await f.api.request(f.a, `${f.root}/pages/${p.id}?revision=${p.revision_id}`, 'GET', undefined, 404);
    checks.push('uncited source change stales and withdrawal revokes all transitive bundle/downstream history; replay denied');

    // An uncited record's access boundary must survive replacement and a downstream publication.
    if (f.native) {
      await f.sql('INSERT INTO org.company_memberships(company_id,user_id) VALUES ($1,$2)', [f.context.companyId, f.b.userId]);
      await f.sql('INSERT INTO org.user_roles(user_id,role_id) SELECT $1,ur.role_id FROM org.user_roles ur JOIN org.roles r ON r.id=ur.role_id WHERE ur.user_id=$2 AND r.company_id=$3', [f.b.userId, f.a.userId, f.context.companyId]);
    } else await f.sql('INSERT INTO membership(id,tenant_id,org_id,user_id,roles,created_at,updated_at,status) SELECT ?,tenant_id,org_id,?,roles,created_at,updated_at,status FROM membership WHERE user_id=? AND org_id=?', [randomUUID(), f.b.userId, f.a.userId, f.context.companyId]);
    const reader = { ...f.b, orgId: f.a.orgId };
    const project = f.native ? await f.api.request(f.a, '/pg/projects', 'POST', { name: 'bundle source ACL' }, 201) : null;
    const document = await f.api.request(f.a, f.prefix + '/documents', 'POST', { title: 'bundle private input', content: 'bundle uncited private source', ...(project ? { project_id: project.id } : { visibility: 'org' }) }, 201);
    const detail = await f.api.request(f.a, f.prefix + '/documents/' + document.id);
    const record = await f.api.request(f.a, f.root + '/sources', 'POST', { kind: 'record', origin_kind: 'document', origin_id: document.id, version: detail.version }, 201);
    const aclBase = await publish(await draft(ingest([raw, record]), [page('acl-a'), page('acl-b')]));
    const aclV2 = await publish(await draft(lint(aclBase), aclBase.result_json.pages.map((p, i) => page('acl-v2-' + i, p.id))));
    const aclDownstream = await publish(await draft(lint(aclV2), [page('acl-downstream')]));
    await projections([...humanReceipt.result_json.pages, ...aclV2.result_json.pages, ...aclDownstream.result_json.pages], reader);
    if (f.native) await f.sql('UPDATE project.projects SET company_id=$1 WHERE id=$2', [f.b.orgId.slice(3), project.id]);
    else await f.api.request(f.a, '/documents/' + document.id, 'PATCH', { version: detail.version, visibility: 'private' });
    await projections(humanReceipt.result_json.pages, reader);
    for (const p of [...aclV2.result_json.pages, ...aclDownstream.result_json.pages]) await f.api.request(reader, `${f.root}/pages/${p.id}?revision=${p.revision_id}`, 'GET', undefined, 404);
    await f.api.request(reader, `${f.root}/pages/${aclV2.result_json.pages[0].id}/change-sets`, 'POST', { expected_version: 2, title: 'launder', markdown: 'drop private source' }, 404);
    checks.push('uncited record access revocation removes bundle and downstream list/graph/query/history and blocks manual laundering');

    // Fresh authority is checked on every serving/publication surface on both engines.
    if (f.native) await f.sql("UPDATE org.company_memberships SET status='suspended' WHERE company_id=$1 AND user_id=$2", [f.context.companyId, f.a.userId]);
    else await f.sql("UPDATE membership SET status='inactive' WHERE org_id=? AND user_id=?", [f.context.companyId, f.a.userId]);
    for (const route of ['/pages', '/graph', `/pages/${humanReceipt.result_json.pages[0].id}`]) await f.api.request(f.a, f.root + route, 'GET', undefined, 403);
    await request('/jobs', { operation: 'query', question: 'bundle', retrieval: { raw: false, published_wiki: true } }, 403);
    await publish(human, 403);
    checks.push('membership revocation blocks current list/graph/page/query/publication HTTP on SQLite and native PG18');
  } finally {
    try { await f.api.close(); }
    finally {
      if (f.native) await f.native.close();
      await mkdir(evidence, { recursive: true });
      await writeFile(new URL(mode + '-http.json', evidence), JSON.stringify({ mode, engine, checks, http: f.api.http, cleanup: { ...f.api.resource, nativeRemoved: nativeData ? !existsSync(nativeData) : null } }, null, 2));
    }
  }
}
