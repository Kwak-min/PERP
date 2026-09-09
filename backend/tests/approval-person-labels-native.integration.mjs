import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';
import { evidenceBody } from './deadline-fixture.js';

const evidence = new URL('../../.omo/evidence/approval-person-labels/', import.meta.url);
test('native PG authorized person projections use active company membership, not global company or foreign IDs', async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const native = await startDailyNativePostgres();
  let server, pg; const http = [], cleanup = {};
  try {
    Object.assign(cleanup, (await native.pool.query("SELECT version() AS engine,current_setting('data_directory') AS directory,current_setting('port') AS port")).rows[0]);
    server = await startTestServer(); pg = await import('../src/config/pg.js');
    async function api(actor, route, method = 'GET', body, expected = 200) {
      const r = await fetch(server.baseUrl + '/pg' + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await r.json(); http.push({ actor: actor?.id, route, method, status: r.status, body: evidenceBody(value) });
      assert.equal(r.status, expected, JSON.stringify(value)); return value;
    }
    async function company(name) {
      const signup = await api(null, '/auth/signup', 'POST', { name, email: `${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
      const actor = { id: signup.user.id, token: signup.token };
      actor.orgId = (await api(actor, '/companies', 'POST', { name, modules: ['approvals'], features: ['approvals'] }, 201)).org_id; return actor;
    }
    const owner = await company('요청자 한서윤'), foreign = await company('외부 비공개 이름');
    const cid = owner.orgId.slice(3);
    async function member(name, permission) {
      const email = `${randomUUID()}@example.invalid`;
      const user = await api(owner, '/members', 'POST', { name, email, password: 'password-1234' }, 201);
      const role = (await native.pool.query('INSERT INTO org.roles(company_id,name) VALUES($1,$2) RETURNING id', [cid, name])).rows[0];
      await native.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [role.id, [permission, 'menu.approvals', 'menu.configured']]);
      await native.pool.query('DELETE FROM org.user_roles WHERE user_id=$1', [user.id]);
      await native.pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES($1,$2)', [user.id, role.id]);
      const login = await api(null, '/auth/login', 'POST', { email, password: 'password-1234' });
      return { id: user.id, token: login.token, orgId: owner.orgId };
    }
    const decider = await member('결재자 김도윤', 'approval.decide'), peer = await member('다른 요청자', 'approval.request');
    const draft = await api(owner, '/approvals/drafts', 'POST', { title: '이름 확인', body: { purpose: '읽기 검증' } }, 201);
    await api(decider, `/approvals/${draft.id}`, 'GET', undefined, 404);
    assert.ok(!(await api(decider, '/approvals')).items.some(row => row.__id === draft.id));
    const pending = await api(owner, `/approvals/${draft.id}/submit`, 'POST', { expected_version: draft.version, form_revision: 1 });
    const before = (await native.pool.query('SELECT to_jsonb(a) AS row FROM org.approval_requests a WHERE id=$1', [draft.id])).rows;
    const historyBefore = (await native.pool.query('SELECT * FROM org.approval_request_history WHERE approval_id=$1 ORDER BY id', [draft.id])).rows;
    for (const actor of [owner, decider]) {
      const detail = await api(actor, `/approvals/${draft.id}`);
      assert.deepEqual(detail.requester_display, { name: '요청자 한서윤' });
      assert.deepEqual(detail.decided_by_display, { name: null });
      assert.equal(detail.requester_id, owner.id); assert.deepEqual(detail.form_snapshot, pending.form_snapshot);
      assert.deepEqual((await api(actor, '/approvals')).items.find(row => row.__id === draft.id).requester_display, detail.requester_display);
      for (const event of (await api(actor, `/approvals/${draft.id}/history`)).items) assert.deepEqual(event.actor_display, { name: '요청자 한서윤' });
    }
    await api(decider, '/members', 'GET', undefined, 403);
    for (const actor of [foreign, peer]) {
      for (const suffix of ['', '/history']) {
        const denied = await api(actor, `/approvals/${draft.id}${suffix}`, 'GET', undefined, 404);
        assert.ok(!JSON.stringify(denied).includes('한서윤'));
      }
      assert.ok(!(await api(actor, '/approvals')).items.some(row => row.__id === draft.id));
    }
    assert.deepEqual((await native.pool.query('SELECT to_jsonb(a) AS row FROM org.approval_requests a WHERE id=$1', [draft.id])).rows, before);
    assert.deepEqual((await native.pool.query('SELECT * FROM org.approval_request_history WHERE approval_id=$1 ORDER BY id', [draft.id])).rows, historyBefore);
    await api(decider, `/approvals/${draft.id}/actions`, 'POST', { decision: 'approve' });
    let decided = await api(owner, `/approvals/${draft.id}`);
    assert.deepEqual(decided.decided_by_display, { name: '결재자 김도윤' }); assert.equal(decided.decided_by, decider.id);
    const recorded = (await native.pool.query('SELECT * FROM org.approval_request_history WHERE approval_id=$1 ORDER BY id', [draft.id])).rows;
    // Global company differs, but a current membership still authorizes the name.
    await native.pool.query('UPDATE auth.users SET company_id=$2,name=$3 WHERE id=$1', [decider.id, foreign.orgId.slice(3), '결재자 현재 이름']);
    assert.deepEqual((await api(owner, `/approvals/${draft.id}`)).decided_by_display, { name: '결재자 현재 이름' });
    await native.pool.query("UPDATE org.company_memberships SET status='left' WHERE company_id=$1 AND user_id=$2", [cid, decider.id]);
    decided = await api(owner, `/approvals/${draft.id}`); assert.deepEqual(decided.decided_by_display, { name: null });
    assert.deepEqual((await api(owner, `/approvals/${draft.id}/history`)).items.find(row => row.action === 'decision.approve').actor_display, { name: null });
    assert.deepEqual((await native.pool.query('SELECT * FROM org.approval_request_history WHERE approval_id=$1 ORDER BY id', [draft.id])).rows, recorded);
    const legacy = (await native.pool.query(`INSERT INTO org.approval_requests(company_id,request_type,requester_id,target_user_id,status,decided_by,decided_at) VALUES($1,'generic',$2,$2,'approved',$2,now()) RETURNING id`, [cid, foreign.id])).rows[0];
    const old = await api(owner, `/approvals/${legacy.id}`);
    assert.deepEqual(old.requester_display, { name: null }); assert.deepEqual(old.decided_by_display, { name: null });
    const list = (await api(owner, '/approvals')).items.find(row => row.__id === String(legacy.id));
    assert.deepEqual(list.requester_display, { name: null }); assert.equal(list.신청자, null); assert.equal(list.대상, null);
    assert.deepEqual((await api(owner, `/approvals/${legacy.id}/history`)).items[0].actor_display, { name: null });
    assert.ok(!JSON.stringify([old, list]).includes('외부 비공개 이름'));
    for (const assignment of ["account_status='suspended'", "account_status='active',approval_status='pending'", "approval_status='approved',name=' '"]) {
      await native.pool.query(`UPDATE auth.users SET ${assignment} WHERE id=$1`, [owner.id]);
      // Restore the decider's company membership; global company remains different.
      await native.pool.query("UPDATE org.company_memberships SET status='active' WHERE company_id=$1 AND user_id=$2", [cid, decider.id]);
      assert.deepEqual((await api(decider, `/approvals/${draft.id}`)).requester_display, { name: null });
      assert.deepEqual((await api(decider, '/approvals')).items.find(row => row.__id === draft.id).requester_display, { name: null });
      assert.deepEqual((await api(decider, `/approvals/${draft.id}/history`)).items[0].actor_display, { name: null });
    }
  } finally {
    if (server) { await server.close(); cleanup.serverClosed = true; }
    await pg?.closePgPool(); await native.close(); cleanup.nativeClosed = true; cleanup.directoryRemoved = !existsSync(cleanup.directory);
    await mkdir(evidence, { recursive: true }); await writeFile(new URL('pg-http.json', evidence), JSON.stringify({ http, cleanup }, null, 2));
  }
});
