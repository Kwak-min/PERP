import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
const evidence = new URL('../../.omo/evidence/task-22-revision/', import.meta.url);
test('task22 native PostgreSQL exact review regressions', async t => {
  const native = await startDailyNativePostgres();
  let server, pg, cleanup = {}; const http = [];
  try {
    cleanup = (await native.pool.query("SELECT current_setting('data_directory') AS directory,current_setting('port') AS port,version() AS version")).rows[0];
    for (const name of ['perp_additions_v12_deadline_expenses.sql', 'perp_additions_v13_approval_states.sql', 'perp_additions_v14_approval_details.sql']) await native.pool.query(await readFile(new URL('../../db/' + name, import.meta.url), 'utf8'));
    await native.pool.query(await readFile(new URL('../../db/perp_additions_v14_approval_details.sql', import.meta.url), 'utf8'));
    server = await startTestServer(); pg = await import('../src/config/pg.js');
    async function api(actor, route, method = 'GET', body, status = 200) {
      const response = await fetch(server.baseUrl + '/pg' + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json(); http.push({ route, method, status: response.status, body: route.startsWith('/auth') ? undefined : value });
      assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`); return value;
    }
    const signup = await api(null, '/auth/signup', 'POST', { name: 'Revision PG', email: `revision-${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
    const owner = { token: signup.token, id: signup.user.id };
    const company = await api(owner, '/companies', 'POST', { name: 'REVISION_TEMP', modules: ['approvals'], features: ['approvals'] }, 201); owner.orgId = company.org_id;
    const make = () => api(owner, '/approvals/drafts', 'POST', { title: 'Revision PG draft', body: { purpose: 'Review' } }, 201);
    const submit = (draft, revision = 1, status = 200) => api(owner, `/approvals/${draft.id}/submit`, 'POST', { expected_version: draft.version, form_revision: revision }, status);

    await t.test('finding 6: immediate payload survives detail and linked resubmit; old decision is available honestly', async () => {
      const old = await api(owner, '/approvals', 'POST', { request_type: 'Compatibility request', note: 'Original payload must survive' }, 201);
      const detail = await api(owner, `/approvals/${old.id}`);
      const stored = (await native.pool.query('SELECT payload FROM org.approval_requests WHERE id=$1', [old.id])).rows[0];
      assert.deepEqual(detail.body, stored.payload);
      await api(owner, `/approvals/${old.id}/decide`, 'POST', { decision: 'reject', comment: 'Return for review' });
      const rejected = await api(owner, `/approvals/${old.id}`);
      const linked = await api(owner, `/approvals/${old.id}/resubmit`, 'POST', { expected_version: rejected.version }, 201);
      assert.deepEqual(linked.body, stored.payload);
      const history = (await api(owner, `/approvals/${old.id}/history`)).items;
      assert.equal(history.length, 1); assert.equal(history[0].action, 'decision.reject');
      assert.equal(history[0].snapshot, null); assert.equal(history[0].comment, 'Return for review');
      assert.equal(history[0].origin, 'legacy_decision');
      assert.deepEqual((await native.pool.query('SELECT payload FROM org.approval_requests WHERE id=$1', [old.id])).rows[0], stored);
      // A dedicated empty body is not missing: never replace it by arbitrary payload.
      const empty = await api(owner, '/approvals/drafts', 'POST', { body: {} }, 201);
      await native.pool.query('UPDATE org.approval_requests SET payload=$2::jsonb WHERE id=$1', [empty.id, JSON.stringify({ note: 'not the dedicated body' })]);
      assert.deepEqual((await api(owner, `/approvals/${empty.id}`)).body, {});
    });

    await t.test('finding 3: inherited target is freshly rechecked at submit', async () => {
      const member = await api(owner, '/members', 'POST', { name: 'Reference target', email: `target-${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
      const old = await api(owner, '/approvals', 'POST', { request_type: 'Compatibility target', target_user_id: String(member.id), note: 'target' }, 201);
      await api(owner, `/approvals/${old.id}/decide`, 'POST', { decision: 'reject', comment: 'Return' });
      const source = await api(owner, `/approvals/${old.id}`);
      const linked = await api(owner, `/approvals/${old.id}/resubmit`, 'POST', { expected_version: source.version }, 201);
      const patched = await api(owner, `/approvals/${linked.id}/draft`, 'PATCH', { expected_version: linked.version, title: 'Inherited reference', body: { purpose: 'Reference check' } });
      await native.pool.query("UPDATE org.company_memberships SET status='suspended' WHERE company_id=$1 AND user_id=$2", [owner.orgId.slice(3), member.id]);
      await submit(patched, 1, 404);
      assert.equal((await api(owner, `/approvals/${linked.id}`)).status, 'draft');
      assert.equal((await native.pool.query("SELECT count(*)::int AS n FROM org.approval_request_history WHERE approval_id=$1 AND action='submitted'", [linked.id])).rows[0].n, 0);
    });

    await t.test('finding 7: pending OLD state prevents SQL unlock and boundary edits', async () => {
      const draft = await make(); await submit(draft);
      const client = await native.pool.connect();
      try {
        for (const assignment of ["workflow_locked=false", "workflow_locked=false,title='bypass'", "status='draft'", "requester_id=NULL", "company_id=0", "submitted_at=NULL", "request_type='changed'"]) {
          await client.query('BEGIN');
          try { await assert.rejects(client.query(`UPDATE org.approval_requests SET ${assignment} WHERE id=$1`, [draft.id]), { code: '23514' }); }
          finally { await client.query('ROLLBACK'); }
        }
      } finally { client.release(); }
      assert.equal((await api(owner, `/approvals/${draft.id}`)).workflow_locked, true);
    });

    await t.test('finding 2: builtin to managed revision is monotonic; stale 1 is rejected', async () => {
      const draft = await make(); const original = (await api(owner, '/approvals/forms')).items.find(row => row.key === 'generic');
      const override = await api(owner, '/approvals/forms', 'POST', { key: 'generic', name: 'Changed generic', fields: [{ key: 'purpose', type: 'text', required: false }] }, 201);
      assert.equal(override.revision, original.revision + 1);
      await submit(draft, original.revision, 409);
      assert.equal((await api(owner, `/approvals/${draft.id}`)).status, 'draft');
      assert.equal((await submit(draft, override.revision)).form_snapshot.revision, override.revision);
    });

    await t.test('company-first actual two-client decide/withdraw uses deterministic event barriers', async () => {
      const revision = (await api(owner, '/approvals/forms')).items.find(row => row.key === 'generic').revision;
      const draft = await make(); const pending = await submit(draft, revision);
      const events = new EventEmitter(), wrapped = new Map(), pids = []; let armed = true, release;
      const gate = new Promise(resolve => { release = resolve; });
      const acquire = client => {
        if (wrapped.has(client)) return;
        const query = client.query; wrapped.set(client, query);
        client.query = function(text, ...args) {
          if (armed && typeof text === 'string' && /SELECT id FROM org\.companies .*FOR UPDATE/.test(text)) {
            const position = pids.push(client.processID);
            if (position === 2) events.emit('second-attempt');
            return (async () => { const result = await query.call(this, text, ...args); if (position === 1) { events.emit('first-locked'); await gate; } return result; })();
          }
          return query.call(this, text, ...args);
        };
      };
      pg.pgPool.on('acquire', acquire);
      const firstReady = once(events, 'first-locked', { signal: AbortSignal.timeout(10000) });
      const secondReady = once(events, 'second-attempt', { signal: AbortSignal.timeout(10000) });
      let first, second;
      try {
        first = api(owner, `/approvals/${draft.id}/actions`, 'POST', { decision: 'approve', confirm_self_decision: true });
        await firstReady;
        second = api(owner, `/approvals/${draft.id}/withdraw`, 'POST', { expected_version: pending.version }, 409);
        await secondReady; release(); await Promise.all([first, second]); armed = false;
        assert.equal(new Set(pids).size, 2);
        assert.equal((await api(owner, `/approvals/${draft.id}`)).status, 'approved');
        const history = (await api(owner, `/approvals/${draft.id}/history`)).items;
        assert.equal(history.filter(row => row.action.startsWith('decision.') || row.action === 'withdrawn').length, 1);
        http.push({ racePids: pids, statuses: [200, 409] });
      } finally {
        armed = false; release(); await Promise.allSettled([first, second].filter(Boolean)); pg.pgPool.off('acquire', acquire);
        for (const [client, query] of wrapped) client.query = query;
      }
    });
  } finally {
    if (server) { await server.close(); cleanup.serverClosed = true; }
    await pg?.closePgPool(); await native.close(); cleanup.nativeClosed = true; cleanup.directoryRemoved = !existsSync(cleanup.directory);
    await mkdir(evidence, { recursive: true });
    await writeFile(new URL('revision-native-http.json', evidence), JSON.stringify({ http, cleanup }, null, 2));
  }
});
