import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';

test('native HTTP history retains string IDs but orders events 9/10/11/12 numerically', async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1'); process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
  const native = await startDailyNativePostgres(); let server, pg;
  const evidence = new URL('../../.omo/evidence/task-23-revision/', import.meta.url), proof = { http: [], cleanup: {} };
  try {
    proof.native = (await native.pool.query("SELECT version(),current_setting('data_directory') AS directory")).rows[0];
    assert.match(proof.native.version, /PostgreSQL 18/);
    for (const name of ['perp_additions_v12_deadline_expenses.sql','perp_additions_v13_approval_states.sql','perp_additions_v14_approval_details.sql']) await native.pool.query(await readFile(new URL('../../db/' + name, import.meta.url), 'utf8'));
    server = await startTestServer(); pg = await import('../src/config/pg.js');
    let actor;
    async function http(route, method = 'GET', body, status = 200) {
      const response = await fetch(server.baseUrl + '/pg' + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const value = await response.json(); proof.http.push({ route, method, status: response.status, body: route.startsWith('/auth') ? undefined : value });
      assert.equal(response.status, status, JSON.stringify(value)); return value;
    }
    const signup = await http('/auth/signup', 'POST', { name: 'History order', email: `history-${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
    actor = { token: signup.token }; actor.orgId = (await http('/companies', 'POST', { name: 'HISTORY_ISOLATED', modules: ['approvals'], features: ['approvals'] }, 201)).org_id;
    // Only the isolated sequence is positioned. Every event is written through real HTTP.
    await native.pool.query("SELECT setval(pg_get_serial_sequence('org.approval_request_history','id'), 9, false)");
    let draft = await http('/approvals/drafts', 'POST', { title: 'Ordered history', body: { purpose: 'Native timeline regression' } }, 201);
    draft = await http(`/approvals/${draft.id}/draft`, 'PATCH', { expected_version: draft.version, title: 'Ordered updated' });
    await http(`/approvals/${draft.id}/submit`, 'POST', { expected_version: draft.version, form_revision: 1 });
    await http(`/approvals/${draft.id}/actions`, 'POST', { decision: 'approve', confirm_self_decision: true });
    const history = (await http(`/approvals/${draft.id}/history`)).items;
    assert.deepEqual(history.map(row => row.id), ['9','10','11','12']);
    assert.deepEqual(history.map(row => row.action), ['draft.created','draft.updated','submitted','decision.approve']);
    assert.ok(history.every((row, index) => index === 0 || Date.parse(row.created_at) >= Date.parse(history[index - 1].created_at)));
    proof.status = 'passed';
  } catch (error) { proof.status = 'failed'; proof.error = error.stack; throw error; }
  finally {
    await server?.close(); await pg?.closePgPool(); await native.close();
    proof.cleanup = { apiClosed: true, nativeClosed: true, directoryRemoved: !existsSync(proof.native?.directory ?? '') };
    await mkdir(evidence, { recursive: true }); await writeFile(new URL('history-native-http.json', evidence), JSON.stringify(proof, null, 2));
  }
});
