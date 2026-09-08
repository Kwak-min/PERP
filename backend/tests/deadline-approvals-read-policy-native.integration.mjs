import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'read-policy-receipts');
const evidence = new URL('../../.omo/evidence/task-22-read-policy-revision/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('native HTTP approval read policy after requester-to-decider grant transition', async t => {
  const native = await startDailyNativePostgres();
  let server, pg, cleanup = {}; const http = [], observations = [];
  try {
    cleanup = (await native.pool.query("SELECT version() AS version,current_setting('port') AS port,current_setting('data_directory') AS directory")).rows[0];
    assert.match(cleanup.version, /PostgreSQL 18\.6/);
    assert.ok(!protectedPorts.has(Number(cleanup.port)));
    for (const name of ['perp_additions_v12_deadline_expenses.sql', 'perp_additions_v13_approval_states.sql', 'perp_additions_v14_approval_details.sql']) await native.pool.query(await readFile(new URL('../../db/' + name, import.meta.url), 'utf8'));
    server = await startTestServer(); pg = await import('../src/config/pg.js');
    const headers = actor => actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {};
    async function api(actor, route, method = 'GET', body, expected = 200) {
      const r = await fetch(server.baseUrl + '/pg' + route, { method, headers: { ...headers(actor), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await r.json(); http.push({ actor: actor?.id, route, method, status: r.status, body: route.startsWith('/auth') ? undefined : value });
      assert.equal(r.status, expected, `${method} ${route}: ${JSON.stringify(value)}`); return value;
    }
    async function company(label) {
      const signup = await api(null, '/auth/signup', 'POST', { name: label, email: `${label}-${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
      const actor = { id: signup.user.id, token: signup.token };
      actor.orgId = (await api(actor, '/companies', 'POST', { name: label, modules: ['approvals'], features: ['approvals'] }, 201)).org_id; return actor;
    }
    const owner = await company('READ_POLICY_ONLY'), foreign = await company('READ_POLICY_FOREIGN');
    const cid = owner.orgId.slice(3);
    async function role(name, permission) {
      const id = (await native.pool.query('INSERT INTO org.roles(company_id,name) VALUES($1,$2) RETURNING id', [cid, name])).rows[0].id;
      await native.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [id, [permission, 'menu.approvals', 'menu.configured']]); return id;
    }
    const requesterRole = await role('READ_REQUESTER', 'approval.request'), deciderRole = await role('READ_DECIDER', 'approval.decide');
    async function member(label, roleId) {
      const email = `${label}-${randomUUID()}@example.invalid`;
      const created = await api(owner, '/members', 'POST', { name: label, email, password: 'password-1234' }, 201);
      await native.pool.query('DELETE FROM org.user_roles WHERE user_id=$1', [created.id]);
      await native.pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES($1,$2)', [created.id, roleId]);
      const login = await api(null, '/auth/login', 'POST', { email, password: 'password-1234' });
      return { id: created.id, token: login.token, orgId: owner.orgId };
    }
    const requester = await member('transition-requester', requesterRole), peer = await member('other-requester', requesterRole), decider = await member('pool-decider', deciderRole);
    const make = () => api(requester, '/approvals/drafts', 'POST', { title: 'Read policy draft', body: { purpose: 'Private draft payload' } }, 201);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    async function upload(actor = requester, expected = 201) {
      const r = await fetch(server.baseUrl + '/pg/approvals/receipt-uploads', { method: 'POST', headers: { ...headers(actor), 'Content-Type': 'image/png', 'X-Upload-Name': 'read-policy.png' }, body: png, signal: AbortSignal.timeout(10000) });
      const value = await r.json(); http.push({ actor: actor.id, route: '/approvals/receipt-uploads', method: 'POST', status: r.status });
      assert.equal(r.status, expected, JSON.stringify(value)); return value;
    }
    async function receipt(actor, parent, fileId, expected = 200) {
      const route = `/approvals/${parent.id}/receipts/${fileId}`;
      const r = await fetch(server.baseUrl + '/pg' + route, { headers: headers(actor), signal: AbortSignal.timeout(10000) });
      const bytes = Buffer.from(await r.arrayBuffer());
      observations.push({ actor: actor.id, route, status: r.status, length: bytes.length, sha256: hash(bytes), expectedSha256: expected === 200 ? hash(png) : null, error: r.status === 200 ? null : bytes.toString() });
      assert.equal(r.status, expected, `${route}: ${r.status === 200 ? '' : bytes.toString()}`);
      if (expected === 200) { assert.deepEqual(bytes, png); assert.equal(hash(bytes), hash(png)); assert.equal(r.headers.get('cache-control'), 'private, no-store'); }
      else assert.equal(JSON.parse(bytes).error.code, 'NOT_FOUND');
    }
    const originalDraft = await make(), draftUpload = await upload();
    const draft = await api(requester, `/approvals/${originalDraft.id}/draft`, 'PATCH', { expected_version: originalDraft.version, receipt_tokens: [draftUpload.token] });
    const draftFile = draft.attachment_snapshot[0].file_id;
    const submittedDraft = await make(), submittedUpload = await upload();
    const pending = await api(requester, `/approvals/${submittedDraft.id}/submit`, 'POST', { expected_version: submittedDraft.version, form_revision: 1, receipt_tokens: [submittedUpload.token] });
    const pendingFile = pending.attachment_snapshot[0].file_id;
    const spare = await upload();
    await receipt(requester, draft, draftFile); await receipt(requester, pending, pendingFile);
    const before = (await native.pool.query('SELECT to_jsonb(a) AS row FROM org.approval_requests a WHERE id=ANY($1::bigint[]) ORDER BY id', [[draft.id, pending.id]])).rows;
    await native.pool.query('UPDATE org.user_roles SET role_id=$2 WHERE user_id=$1 AND role_id=$3', [requester.id, deciderRole, requesterRole]);

    await t.test('revoked requester privilege: list agrees with private404 own draft detail and history', async () => {
      await api(requester, `/approvals/${draft.id}`, 'GET', undefined, 404);
      await api(requester, `/approvals/${draft.id}/history`, 'GET', undefined, 404);
      const list = await api(requester, '/approvals');
      assert.equal(list.can_request, false); assert.equal(list.can_decide, true);
      const exposed = list.items.find(row => String(row.__id) === draft.id);
      observations.push({ case: 'revoked-requester-draft-list', detail: 404, history: 404, listed: !!exposed, row: exposed });
      assert.equal(!!exposed, false, 'own draft denied by detail must not expose payload through list');
      assert.ok(list.items.some(row => String(row.__id) === pending.id));
    });
    await t.test('decider-only owner: readable submitted detail and history permit original receipt bytes', async () => {
      await api(requester, `/approvals/${pending.id}`); await api(requester, `/approvals/${pending.id}/history`);
      await receipt(requester, pending, pendingFile);
    });
    await t.test('read inheritance preserves draft, other-requester, wrong-parent and company denials', async () => {
      await receipt(requester, draft, draftFile, 404);
      for (const actor of [peer, decider, foreign]) {
        await api(actor, `/approvals/${draft.id}`, 'GET', undefined, 404);
        await api(actor, `/approvals/${draft.id}/history`, 'GET', undefined, 404);
        assert.ok(!(await api(actor, '/approvals')).items.some(row => String(row.__id) === draft.id));
        await receipt(actor, draft, draftFile, 404);
      }
      for (const actor of [peer, foreign]) {
        await api(actor, `/approvals/${pending.id}`, 'GET', undefined, 404);
        await api(actor, `/approvals/${pending.id}/history`, 'GET', undefined, 404);
        assert.ok(!(await api(actor, '/approvals')).items.some(row => String(row.__id) === pending.id));
        await receipt(actor, pending, pendingFile, 404);
      }
      await receipt(decider, pending, pendingFile);
      await receipt(decider, pending, draftFile, 404);
    });
    await t.test('decider read permission cannot upload, consume, edit, submit or withdraw', async () => {
      await upload(requester, 403);
      await api(requester, `/approvals/${draft.id}/draft`, 'PATCH', { expected_version: draft.version, receipt_tokens: [spare.token] }, 403);
      await api(requester, `/approvals/${draft.id}/submit`, 'POST', { expected_version: draft.version, form_revision: 1, receipt_tokens: [spare.token] }, 403);
      await api(requester, `/approvals/${pending.id}/withdraw`, 'POST', { expected_version: pending.version }, 403);
      const { consumePgReceipts } = await import('../src/services/pg-receipt-files.service.js');
      const version = (await native.pool.query('SELECT xmin::text AS version FROM org.approval_requests WHERE id=$1', [draft.id])).rows[0].version;
      await assert.rejects(pg.pgTransaction(client => consumePgReceipts(client, { userId: requester.id, companyId: cid }, { kind: 'approval', parentId: draft.id, expectedVersion: version, tokens: [spare.token] })), { code: 'PERMISSION_DENIED' });
      assert.equal((await native.pool.query('SELECT state FROM files.receipt_uploads WHERE token_hash=$1', [hash(spare.token)])).rows[0].state, 'ready');
      assert.deepEqual((await native.pool.query('SELECT to_jsonb(a) AS row FROM org.approval_requests a WHERE id=ANY($1::bigint[]) ORDER BY id', [[draft.id, pending.id]])).rows, before);
    });
  } finally {
    if (server) { await server.close(); cleanup.serverClosed = true; }
    await pg?.closePgPool(); await native.close(); cleanup.nativeClosed = true; cleanup.directoryRemoved = !existsSync(cleanup.directory);
    await mkdir(evidence, { recursive: true });
    await writeFile(new URL('read-policy-native-http.json', evidence), JSON.stringify({ http, observations, cleanup, networkAudit }, null, 2));
  }
});
