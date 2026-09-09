import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';
import { api, startTestServer } from '../../backend/tests/http.js';
import { instrumentNativeGraph, nativeGraphObserver } from './task26-webgl-observer.mjs';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
assert.ok(process.env.DAILY_TEST_PG_BIN);
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = `${root}.omo/evidence/task-26-revision/native`;
await mkdir(evidence, { recursive: true });
const result = { races: [], http: [], browser: [], cleanup: {} };
let native, server, appPool, vite, browser;
try {
  native = await startDailyNativePostgres();
  const database = native.pool, company = native.companyId, user = native.identity.users[0];
  result.engine = (await database.query('SELECT version()')).rows[0].version;
  // The daily fixture owns the base DDL (including notes/project/org tables).
  // Only this integrated graph leaf needs Wiki; do not broaden every daily test.
  const dependencies = ['project.documents', 'project.projects', 'notes.notes', 'notes.vaults', 'org.company_memberships', 'org.roles', 'org.role_permissions', 'org.user_roles', 'org.company_modules', 'org.companies', 'auth.users'];
  const relations = async names => (await database.query('SELECT name, to_regclass(name)::text AS relation FROM unnest($1::text[]) name', [names])).rows;
  result.schema = { dependencies: await relations(dependencies), migrations: ['perp_additions_v15_knowledge_wiki.sql', 'perp_additions_v18_knowledge_invalidation.sql'], passes: [] };
  assert.ok(result.schema.dependencies.every(row => row.relation), 'Native graph schema precondition: base DDL must provide Wiki18 dependent tables');
  for (let replay = 0; replay < 2; replay++) {
    for (const file of result.schema.migrations) await database.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    result.schema.passes.push((await database.query(`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND (n.nspname='knowledge' OR t.tgname LIKE 'wiki_%') ORDER BY n.nspname,c.relname,t.tgname`)).rows);
  }
  assert.deepEqual(result.schema.passes[1], result.schema.passes[0], 'shipped Wiki DDL replay must preserve triggers without duplication');
  result.schema.relations = await relations(['knowledge.wiki', 'knowledge.schema_revision', 'knowledge.source', 'knowledge.source_revision', 'knowledge.page', 'knowledge.page_revision', 'knowledge.job', 'knowledge.job_attempt', 'knowledge.job_input', 'knowledge.dependency', 'knowledge.change_set', 'knowledge.publication', 'knowledge.event']);
  assert.ok(result.schema.relations.every(row => row.relation), 'Native graph schema precondition: shipped Wiki15 tables missing');
  assert.ok(result.schema.passes[1].some(row => row.tgname === 'wiki_generation_changed'), 'Native graph schema precondition: Wiki18 invalidation trigger missing');
  const codes = ['document.read', 'document.write', 'menu.documents', 'menu.knowledge'];
  await database.query("INSERT INTO org.permissions(code,module) SELECT code,'documents' FROM unnest($1::text[]) code ON CONFLICT DO NOTHING", [codes]);
  await database.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.company_id=$1 AND p.code=ANY($2::text[]) ON CONFLICT DO NOTHING', [company, codes]);
  await database.query("INSERT INTO org.company_modules(company_id,module_key) VALUES($1,'documents'),($1,'agent') ON CONFLICT DO NOTHING", [company]);
  const token = randomUUID();
  await database.query('INSERT INTO auth.sessions(user_id,session_token) VALUES($1,$2)', [user.id, token]);
  const actor = { token, orgId: `pg:${company}` };
  server = await startTestServer();
  appPool = (await import('../../backend/src/config/pg.js')).pgPool;
  const request = async (route, method = 'GET', body, expected = 200) => {
    const response = await api(server.baseUrl, `/pg${route}`, { ...actor, method, body });
    result.http.push({ route, method, status: response.status, body: response.body });
    assert.equal(response.status, expected, JSON.stringify(response));
    return response.body;
  };
  const project = await request('/projects', 'POST', { name: 'Graph revision project' }, 201);
  const document = await request('/documents', 'POST', { project_id: project.id, title: 'Native Graph A', content_md: 'Initial' }, 201);
  const other = await request('/documents', 'POST', { project_id: project.id, title: 'Native Graph B', content_md: 'Other' }, 201);
  const note = await request('/vault/notes', 'POST', { title: 'Native Note', content: 'Initial', folder: '/' }, 201);
  assert.equal(typeof note.version, 'string');
  const xmin = async () => (await database.query('SELECT xmin::text AS version FROM notes.notes WHERE id=$1', [note.id])).rows[0].version;
  assert.equal(note.version, await xmin());
  for (const version of [Number(note.version), null, {}, '', 'NaN']) await request(`/vault/notes/${note.id}`, 'PATCH', { version, content: 'Invalid' }, 400);
  assert.equal(await xmin(), note.version);
  const detail = await request(`/records/documents/${document.id}`);
  assert.equal(detail.id, document.id);
  assert.equal(detail.content_md, 'Initial');

  async function compete(name, pattern, route, body) {
    const original = appPool.query, gate = Promise.withResolvers(), pids = [];
    const timeout = AbortSignal.timeout(10000);
    const deadline = new Promise((_, reject) => timeout.addEventListener('abort', () => reject(timeout.reason), { once: true }));
    appPool.query = async function (text, values) {
      if (!pattern.test(text)) return original.call(this, text, values);
      const client = await this.connect();
      try {
        pids.push(client.processID);
        if (pids.length === 2) gate.resolve();
        await Promise.race([gate.promise, deadline]);
        return await client.query(text, values);
      } finally { client.release(); }
    };
    try {
      const responses = await Promise.all(['First', 'Second'].map(label => api(server.baseUrl, `/pg${route}`, { ...actor, method: 'PATCH', body: { ...body, [name === 'generic' ? 'content_md' : 'content']: label } })));
      assert.equal(new Set(pids).size, 2, 'two independent native connections execute the real predicate');
      const statuses = responses.map(r => r.status).sort();
      assert.deepEqual(statuses, [200, 409], JSON.stringify(responses));
      result.races.push({ name, pids, statuses, responses: responses.map(r => r.body) });
      return responses.find(r => r.status === 200).body;
    } finally { gate.resolve(); appPool.query = original; }
  }
  const generic = await compete('generic', /UPDATE project\.documents t/, `/records/documents/${document.id}`, { version: detail.version });
  assert.equal(generic.id, document.id);
  assert.equal(generic.version, detail.version + 1);
  const direct = await compete('direct', /UPDATE project\.documents d/, `/documents/${document.id}`, { version: generic.version });
  assert.equal(direct.version, generic.version + 1);
  const savedNote = await compete('xmin', /UPDATE notes\.notes n/, `/vault/notes/${note.id}`, { version: note.version });
  assert.equal(savedNote.version, await xmin());
  assert.equal(typeof savedNote.version, 'string');

  const observer = nativeGraphObserver(root);
  vite = await createServer({ configFile: false, root: `${root}frontend`, envDir: process.env.DEADLINE_TEMP_ROOT, resolve: observer.resolve, optimizeDeps: observer.optimizeDeps, plugins: [observer.plugin, react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  await page.addInitScript(session => { localStorage.setItem('orbitflow.session.v1', JSON.stringify(session)); localStorage.setItem('orbitflow.demoMode', '0'); }, { ...actor, name: user.name, email: user.email, mustChangePassword: false, organizations: [{ org_id: actor.orgId, org_name: 'Native company', org_type: 'perp_db', roles: ['member'] }] });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  async function arm(selector, absent = false) {
    await page.evaluate(({ selector, absent }) => {
      window.__nativeSignal = new Promise((resolve, reject) => {
        const timeout = AbortSignal.timeout(10000);
        const observer = new MutationObserver(() => {
          if (Boolean(document.querySelector(selector)) !== absent) { observer.disconnect(); resolve(); }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true });
        timeout.addEventListener('abort', () => { observer.disconnect(); reject(timeout.reason); }, { once: true });
      });
    }, { selector, absent });
  }
  const signal = () => page.evaluate(() => window.__nativeSignal);
  await page.goto(`${origin}/documents`, { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('row').filter({ hasText: 'Native Graph A' });
  await row.waitFor();
  const matcher = `**/api/v1/pg/records/documents/${document.id}`;
  await page.route(matcher, async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, id: other.id } });
  });
  await arm('main .screen-notice');
  await row.getByRole('button', { name: '수정', exact: true }).click();
  await signal();
  assert.equal(await page.getByRole('dialog').count(), 0, 'forged detail never opens an editor');
  await page.unroute(matcher);
  result.browser.push('forged detail rejected before edit');
  await arm('[role="dialog"]');
  await row.getByRole('button', { name: '수정', exact: true }).click();
  await signal();
  const dialog = page.getByRole('dialog');
  await writeFile(`${evidence}/dialog.html`, await dialog.evaluate(node => node.outerHTML));
  await page.screenshot({ path: `${evidence}/dialog.png`, fullPage: true });
  assert.equal(await dialog.locator('textarea').count(), 1);
  await dialog.locator('textarea').fill('Native modal draft');
  let patchBody;
  await page.route(matcher, async route => {
    patchBody = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.fulfill({ response, json: { ...await response.json(), id: other.id } });
  });
  await arm('[role="dialog"] [role="alert"]');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await signal();
  assert.equal(patchBody.version, direct.version);
  assert.equal(await dialog.locator('textarea').inputValue(), 'Native modal draft');
  assert.equal(await dialog.count(), 1, 'forged write receipt cannot close or report completion');
  await page.screenshot({ path: `${evidence}/forged-write.png`, fullPage: true });
  await page.unroute(matcher);
  result.browser.push('forged PATCH receipt rejected; draft retained; captured version sent');
  assert.equal((await request(`/documents/${document.id}`)).content, 'Native modal draft', 'receipt validation cannot undo server writes');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await row.waitFor();
  await arm('[role="dialog"]');
  await row.getByRole('button', { name: '수정', exact: true }).click();
  await signal();
  await dialog.locator('textarea').fill('Native confirmed save');
  await arm('[role="dialog"]', true);
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await signal();
  assert.equal((await request(`/documents/${document.id}`)).content, 'Native confirmed save');
  result.browser.push('matching detail/version/PATCH identity completes a real save');

  const graph = await request('/documents/graph');
  const adversarial = await page.evaluate(async graph => {
    const { knowledgeGraphSchema } = await import('/src/screens/knowledge/model.ts');
    const { prepareKnowledgeGraph } = await import('/src/components/data/knowledgeGraphStageModel.ts');
    const [a, b] = graph.nodes.filter(n => n.kind === 'document');
    const edge = (source, target, id) => ({ id, source: source.id, source_renderer_id: source.renderer_id, target_id: target.id, target_renderer_id: target.renderer_id, target_title: target.title, kind: 'link', binding: 'explicit', resolution: 'resolved', declaration: { span: [id, id + 1] } });
    const edges = [edge(a, b, 0), edge(b, a, 1), edge(a, b, 2)];
    const parsed = knowledgeGraphSchema.parse({ ...graph, edges });
    const snapshot = JSON.stringify(parsed);
    const scene = prepareKnowledgeGraph(parsed);
    const forged = { ...parsed, edges: [{ ...edges[0], source_renderer_id: b.renderer_id, target_renderer_id: a.renderer_id }] };
    return { links: scene.links.flatMap(edge => [edge.render_source, edge.render_target].map(id => scene.nodes.findIndex(n => n.render_id === id))), count: scene.links.length, declarations: scene.links.map(edge => edge.declaration), unchanged: JSON.stringify(parsed) === snapshot, forgedAccepted: knowledgeGraphSchema.safeParse(forged).success, sourceIndex: graph.nodes.findIndex(n => n.renderer_id === a.renderer_id), targetIndex: graph.nodes.findIndex(n => n.renderer_id === b.renderer_id) };
  }, graph);
  const { sourceIndex: a, targetIndex: b } = adversarial;
  assert.deepEqual(adversarial.links, [a, b, b, a, a, b]);
  assert.equal(adversarial.count, 3);
  assert.deepEqual(adversarial.declarations, [{ span: [0, 1] }, { span: [1, 2] }, { span: [2, 3] }]);
  assert.equal(adversarial.unchanged, true);
  assert.equal(adversarial.forgedAccepted, false);
  result.adversarial = adversarial;
  // Subscribe before navigation to the real engine's settled WebGL frame.
  // Only edges are adversarial; nodes and authorization still come from native HTTP.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(instrumentNativeGraph);
  const wikiPaths = ['/pg/documents/wiki', '/pg/documents/wiki/graph', '/pg/documents/wiki/pages', '/pg/documents/wiki/events'];
  const wikiResponses = wikiPaths.map(path => page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1${path}`));
  await page.route('**/api/v1/pg/documents/graph', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const graph = await response.json();
    const [a, b] = graph.nodes.filter(node => node.kind === 'document');
    const edge = (source, target, id) => ({ id, source: source.id, source_renderer_id: source.renderer_id, target_id: target.id, target_renderer_id: target.renderer_id, target_title: target.title, kind: 'link', binding: 'explicit', resolution: 'resolved', declaration: { span: [id, id + 1] } });
    await route.fulfill({ response, json: { ...graph, edges: [edge(a, b, 0), edge(b, a, 1), edge(a, b, 2)] } });
  });
  await page.goto(`${origin}/documents/graph`, { waitUntil: 'domcontentloaded' });
  const painted = await page.evaluate(() => window.__nativePaint);
  result.adversarial.webgl = painted;
  assert.equal(painted.event, 'onEngineStop + WebGL render');
  assert.equal(painted.contextLost, false);
  assert.equal(painted.canvasConnected, true);
  assert.ok(painted.renderCalls > 0);
  assert.equal(painted.nodes.length, graph.nodes.length);
  for (const node of painted.nodes) {
    const dto = graph.nodes.find(n => n.renderer_id === node.rendererId);
    assert.ok(dto, 'rendered node must retain current typed identity from native HTTP');
    assert.equal(node.id, dto.id); assert.deepEqual(node.identity, dto.identity);
    assert.equal(node.attached, true); assert.equal(node.drawn, true);
  }
  assert.equal(painted.links.length, 3, 'actual WebGL must draw all reciprocal and parallel declarations');
  const near = (actual, expected) => assert.ok(Math.hypot(...actual.map((v, i) => v - expected[i])) < 1e-6, JSON.stringify({ actual, expected }));
  for (const [index, link] of painted.links.entries()) {
    const source = graph.nodes[index === 1 ? b : a], target = graph.nodes[index === 1 ? a : b];
    assert.equal(link.source, source.id); assert.equal(link.target, target.id);
    assert.equal(link.sourceRendererId, source.renderer_id); assert.equal(link.targetRendererId, target.renderer_id);
    assert.equal(link.kind, 'link'); assert.equal(link.binding, 'explicit'); assert.equal(link.resolution, 'resolved');
    assert.deepEqual(link.declaration, { span: [index, index + 1] });
    assert.equal(link.id, index); assert.ok(link.vertices > 0);
    assert.equal(link.attached, true); assert.equal(link.drawn, true);
    near(link.start, link.sourcePosition); near(link.end, link.targetPosition);
    assert.equal(link.arrowLength, 5); assert.equal(link.arrowHeight, 5); assert.equal(link.arrowGeometry, 'ConeGeometry');
    assert.equal(link.arrowVisible, true); assert.equal(link.arrowAttached, true); assert.equal(link.arrowDrawn, true);
    assert.ok(link.arrowHead.reduce((sum, v, i) => sum + (v - link.arrowTail[i]) * (link.targetPosition[i] - link.sourcePosition[i]), 0) > 0, 'physical arrow must point source to target, including the reciprocal link');
    for (const previous of painted.links.slice(0, index)) assert.ok(Math.hypot(...link.midpoint.map((v, i) => v - previous.midpoint[i])) > 1e-6, 'reciprocal and parallel declarations need distinct physical geometry paths');
  }
  assert.equal(new Set(painted.links.map(link => link.renderEdgeId)).size, 3);
  near(painted.links[0].start, painted.links[2].start); near(painted.links[0].end, painted.links[2].end);
  near(painted.links[1].start, painted.links[0].end); near(painted.links[1].end, painted.links[0].start);
  result.wiki = await Promise.all(wikiResponses.map(async pending => {
    const response = await pending;
    assert.equal(response.status(), 200, `Native Wiki schema/HTTP precondition: ${response.url()}`);
    return { path: new URL(response.url()).pathname, status: response.status(), contentType: response.headers()['content-type'] };
  }));
  await page.screenshot({ path: `${evidence}/adversarial-graph.png`, fullPage: true });
  result.browser.push('native typed identities, reciprocal/parallel physical paths and arrows submitted by actual WebGL renderer');
  assert.deepEqual(errors, []);
  result.chrome = browser.version();
} catch (error) {
  result.error = { message: String(error), stack: error.stack };
  throw error;
} finally {
  await browser?.close(); result.cleanup.browser = true;
  await vite?.close(); result.cleanup.vite = true;
  await appPool?.end();
  await server?.close(); result.cleanup.http = true;
  await native?.close(); result.cleanup.nativeClusterStoppedAndRemoved = true;
  await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
