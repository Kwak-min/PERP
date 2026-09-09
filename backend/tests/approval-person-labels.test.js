import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startDeadlineServer } from './deadline-fixture.js';
import { createOwnerOrg } from './http.js';

const evidence = new URL('../../.omo/evidence/approval-person-labels/', import.meta.url);
test('SQLite authorized approval reads project only current participant names without changing snapshots', async () => {
  const server = await startDeadlineServer();
  try {
    const owner = await createOwnerOrg(server.baseUrl, ['approvals']);
    const foreign = await createOwnerOrg(server.baseUrl, ['approvals']);
    const { db } = await import('../src/config/db.js');
    db().prepare('UPDATE app_user SET name=? WHERE id=?').run('요청자 한서윤', owner.userId);
    db().prepare('UPDATE app_user SET name=? WHERE id=?').run('외부 비공개 이름', foreign.userId);
    const role = await server.request(owner, '/settings/roles', 'POST', { name: '결재 전용', scope: 'all', permissions: ['menu.approvals', 'approval.decide'] }, 201);
    async function member(name) {
      const email = `${randomUUID()}@example.invalid`;
      const invite = await server.request(owner, '/members/invites', 'POST', { email, roles: [role.key] }, 201);
      const signup = await server.request(null, '/auth/signup', 'POST', { name, email, password: 'password-1234', invitation_token: invite.token }, 201);
      return { token: signup.access_token, userId: signup.user.id, orgId: owner.orgId };
    }
    const approver = await member('결재자 김도윤'), unrelated = await member('관계없는 사용자');
    const draft = await server.request(owner, '/approvals/drafts', 'POST', { title: '신원 표시 검증', body: { purpose: '승인 검토' }, steps: [{ approver_id: approver.userId }] }, 201);
    await server.request(approver, `/approvals/requests/${draft.id}`, 'GET', undefined, 404);
    const pending = await server.request(owner, `/approvals/requests/${draft.id}/submit`, 'POST', { expected_version: draft.version, form_revision: 1 });
    const before = db().prepare('SELECT * FROM approval WHERE id=?').get(draft.id);
    const beforeHistory = db().prepare('SELECT * FROM approval_history WHERE approval_id=? ORDER BY id').all(draft.id);
    for (const actor of [owner, approver]) {
      const detail = await server.request(actor, `/approvals/requests/${draft.id}`);
      assert.deepEqual(detail.requester_display, { name: '요청자 한서윤' });
      assert.deepEqual(detail.steps[0].approver_display, { name: '결재자 김도윤' });
      assert.equal(detail.requester_id, owner.userId); assert.equal(detail.steps[0].approver_id, approver.userId);
      assert.deepEqual(detail.form_snapshot, pending.form_snapshot);
      const events = (await server.request(actor, `/approvals/requests/${draft.id}/history`)).items;
      assert.ok(events.length > 0); for (const event of events) assert.deepEqual(event.actor_display, { name: '요청자 한서윤' });
      const list = await server.request(actor, `/approvals/requests?box=${actor === owner ? 'sent' : 'inbox'}`);
      assert.deepEqual(list.items.find(row => row.id === draft.id).requester_display, detail.requester_display);
    }
    await server.request(approver, '/members', 'GET', undefined, 403);
    for (const actor of [foreign, unrelated]) {
      for (const suffix of ['', '/history']) {
        const denied = await server.request(actor, `/approvals/requests/${draft.id}${suffix}`, 'GET', undefined, 404);
        assert.ok(!JSON.stringify(denied).includes('한서윤')); assert.ok(!JSON.stringify(denied).includes('김도윤'));
      }
      assert.ok(!(await server.request(actor, '/approvals/requests?box=inbox')).items.some(row => row.id === draft.id));
    }
    db().prepare('UPDATE app_user SET name=? WHERE id=?').run('결재자 현재 이름', approver.userId);
    assert.deepEqual((await server.request(owner, `/approvals/requests/${draft.id}`)).steps[0].approver_display, { name: '결재자 현재 이름' });
    assert.deepEqual(db().prepare('SELECT * FROM approval WHERE id=?').get(draft.id), before);
    assert.deepEqual(db().prepare('SELECT * FROM approval_history WHERE approval_id=? ORDER BY id').all(draft.id), beforeHistory);
    await server.request(approver, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'approve' });
    db().prepare("UPDATE membership SET status='left' WHERE org_id=? AND user_id=?").run(owner.orgId, approver.userId);
    const removed = await server.request(owner, `/approvals/requests/${draft.id}`);
    assert.deepEqual(removed.steps[0].approver_display, { name: null });
    assert.deepEqual((await server.request(owner, `/approvals/requests/${draft.id}/history`)).items.find(row => row.action === 'decision.approve').actor_display, { name: null });
    // Compatibility requests can contain old or foreign IDs; neither becomes a directory lookup.
    const legacy = await server.request(owner, '/approvals/requests', 'POST', { title: '기존 경로', steps: [{ approver_id: foreign.userId }, { approver_id: randomUUID() }] }, 201);
    const old = await server.request(owner, `/approvals/requests/${legacy.id}`);
    assert.ok(old.steps.every(step => step.approver_display.name === null));
    assert.ok(!JSON.stringify(old).includes('외부 비공개 이름'));
    db().prepare("UPDATE membership SET status='active' WHERE org_id=? AND user_id=?").run(owner.orgId, approver.userId);
    for (const assignment of ["auth_status='inactive'", "auth_status='active',name=' '"]) {
      db().prepare(`UPDATE app_user SET ${assignment} WHERE id=?`).run(owner.userId);
      const unavailable = await server.request(approver, `/approvals/requests/${draft.id}`);
      assert.deepEqual(unavailable.requester_display, { name: null });
      assert.deepEqual((await server.request(approver, '/approvals/requests?box=completed')).items[0].requester_display, { name: null });
      assert.deepEqual((await server.request(approver, `/approvals/requests/${draft.id}/history`)).items[0].actor_display, { name: null });
    }
    // An unrelated active approver still cannot read this request after identity projection.
    await server.request(unrelated, `/approvals/requests/${legacy.id}`, 'GET', undefined, 404);
  } finally {
    await server.close(); await mkdir(evidence, { recursive: true });
    await writeFile(new URL('sqlite-http.json', evidence), JSON.stringify({ http: server.http, cleanup: server.resource }, null, 2));
  }
});
