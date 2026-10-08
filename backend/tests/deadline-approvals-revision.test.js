import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startDeadlineServer } from './deadline-fixture.js';
import { createOwnerOrg } from './http.js';

const evidence = new URL('../../.omo/evidence/task-22-revision/', import.meta.url);
test('task22 SQLite exact review regressions', async t => {
  const server = await startDeadlineServer();
  try {
    const owner = await createOwnerOrg(server.baseUrl, ['approvals', 'documents']);
    const email = `revision-${randomUUID()}@example.invalid`;
    const invite = await server.request(owner, '/members/invites', 'POST', { email, roles: ['company_admin'] }, 201);
    const signup = await server.request(null, '/auth/signup', 'POST', { name: 'Revision decider', email, password: 'password-1234', invitation_token: invite.token }, 201);
    const decider = { token: signup.access_token, userId: signup.user.id, orgId: owner.orgId };
    const foreign = await createOwnerOrg(server.baseUrl, ['approvals']);
    const { db } = await import('../src/config/db.js');
    const make = (body = {}) => server.request(owner, '/approvals/drafts', 'POST', {
      title: 'Revision draft', body: { purpose: 'Review' }, steps: [{ approver_id: decider.userId }], ...body,
    }, 201);
    const submit = (draft, revision = 1, status = 200) => server.request(owner, `/approvals/requests/${draft.id}/submit`, 'POST', { expected_version: draft.version, form_revision: revision }, status);

    await t.test('finding 1: exact money alone drives snapshot, reauth flag and password gate', async () => {
      const draft = await make({ form_key: 'expense_review', body: { purpose: 'High amount', amount_krw: '1000000.00' } });
      const pending = await submit(draft);
      assert.equal(pending.amount, 100000000);
      assert.equal(pending.requires_reauth, true);
      await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'approve' }, 403);
      await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'approve', reauth_password: 'wrong' }, 403);
      const approved = await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'approve', reauth_password: 'password-1234' });
      assert.equal(approved.status, 'approved');
      const history = (await server.request(owner, `/approvals/requests/${draft.id}/history`)).items;
      assert.equal(history.find(row => row.action === 'submitted').snapshot.amount, pending.amount);
      const overflow = await make({ form_key: 'expense_review', body: { purpose: 'Overflow', amount_krw: '90071992547409.92' } });
      await submit(overflow, 1, 400);
      assert.equal((await server.request(owner, `/approvals/requests/${overflow.id}`)).status, 'draft');
      const exact = await make({ form_key: 'purchase_request', amount: 0, body: { purpose: 'Exact cents', amount_krw: '9999.99' } });
      const small = await submit(exact);
      assert.equal(small.amount, 999999); assert.equal(small.requires_reauth, false);
    });

    await t.test('finding 4: saved draft and linked resubmit routes are readable without decision rows', async () => {
      const draft = await make();
      const detail = await server.request(owner, `/approvals/requests/${draft.id}`);
      assert.equal(db().prepare('SELECT count(*) AS n FROM approval_step WHERE approval_id=?').get(draft.id).n, 0);
      assert.deepEqual(detail.steps.map(({ approver_id, mode, kind }) => ({ approver_id, mode, kind })), [{ approver_id: decider.userId, mode: 'sequential', kind: 'approve' }]);
      assert.equal(detail.steps[0].status, 'draft');
      await server.request(decider, `/approvals/requests/${draft.id}`, 'GET', undefined, 404);
      await submit(draft);
      const rejected = await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'reject', comment: 'Return' });
      const linked = await server.request(owner, `/approvals/requests/${draft.id}/resubmit`, 'POST', { expected_version: rejected.version }, 201);
      assert.equal(linked.steps[0].approver_id, decider.userId);
      assert.equal(linked.steps[0].status, 'draft');
    });

    await t.test('finding 5: completed participants discover exactly readable completed requests', async () => {
      const draft = await make(); await submit(draft);
      await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'approve' });
      assert.equal((await server.request(decider, `/approvals/requests/${draft.id}`)).status, 'approved');
      for (const actor of [owner, decider]) assert.ok((await server.request(actor, '/approvals/requests?box=completed')).items.some(row => row.id === draft.id));
      assert.ok(!(await server.request(foreign, '/approvals/requests?box=completed')).items.some(row => row.id === draft.id));
      assert.ok(!(await server.request(decider, '/approvals/requests?box=inbox')).items.some(row => row.id === draft.id));
    });

    await t.test('finding 3: private document denial is rechecked at submit and resubmit', async () => {
      const document = await server.request(decider, '/documents', 'POST', { title: 'Private reference', content: 'private', visibility: 'private' }, 201);
      await server.request(owner, `/documents/${document.id}`, 'GET', undefined, 404);
      const draft = await make({ subject_type: 'document', subject_id: document.id });
      await submit(draft, 1, 404);
      assert.equal((await server.request(owner, `/approvals/requests/${draft.id}`)).status, 'draft');
      assert.equal(db().prepare('SELECT count(*) AS n FROM approval_step WHERE approval_id=?').get(draft.id).n, 0);
    });
    await t.test('finding 3: resubmit freshly denies a formerly readable reference', async () => {
      const document = await server.request(decider, '/documents', 'POST', { title: 'Initially shared', content: 'reference', visibility: 'org' }, 201);
      const draft = await make({ subject_type: 'document', subject_id: document.id }); await submit(draft);
      const rejected = await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'reject', comment: 'Return' });
      db().prepare("UPDATE document SET visibility='private' WHERE id=?").run(document.id);
      await server.request(owner, `/documents/${document.id}`, 'GET', undefined, 404);
      await server.request(owner, `/approvals/requests/${draft.id}/resubmit`, 'POST', { expected_version: rejected.version }, 404);
      assert.equal(db().prepare('SELECT count(*) AS n FROM approval WHERE predecessor_id=?').get(draft.id).n, 0);
    });

    await t.test('finding 3: reference requires its own current domain menu and enabled module', async () => {
      const document = await server.request(owner, '/documents', 'POST', { title: 'Scoped reference', content: 'reference' }, 201);
      const { resolvePrincipal } = await import('../src/middleware/auth.js');
      const { assertLegacyReference } = await import('../src/services/approval.service.js');
      const principal = resolvePrincipal({ get: name => ({ authorization: `Bearer ${owner.token}`, 'x-org-id': owner.orgId })[name] });
      assert.throws(() => assertLegacyReference({ ...principal, has: code => code !== 'menu.documents' && principal.has(code) }, 'document', document.id), { code: 'NOT_FOUND' });
      const draft = await make({ subject_type: 'document', subject_id: document.id });
      const before = db().prepare('SELECT modules FROM organization WHERE id=?').get(owner.orgId);
      db().prepare('UPDATE organization SET modules=? WHERE id=?').run(before.modules.split(',').filter(key => key !== 'documents').join(','), owner.orgId);
      try {
        await server.request(owner, `/documents/${document.id}`, 'GET', undefined, 403);
        await submit(draft, 1, 404);
      } finally { db().prepare('UPDATE organization SET modules=? WHERE id=?').run(before.modules, owner.orgId); }
    });

    await t.test('finding 7: submitted OLD boundary rejects unlock and unlock+modify SQL', async () => {
      const draft = await make(); await submit(draft);
      for (const assignment of ["workflow_locked=0", "workflow_locked=0,title='bypass'", "status='draft'", "requester_id='other'", "org_id='other'", "payload='{}'", "submitted_at=NULL", "due_at='tomorrow'", "deleted_at='now'"]) {
        db().exec('BEGIN IMMEDIATE');
        try { assert.throws(() => db().prepare(`UPDATE approval SET ${assignment} WHERE id=?`).run(draft.id), /immutable/); }
        finally { db().exec('ROLLBACK'); }
      }
      assert.equal((await server.request(owner, `/approvals/requests/${draft.id}`)).workflow_locked, true);
    });

    await t.test('finding 2: first builtin override advances revision and rejects old submit token', async () => {
      const draft = await make();
      const original = (await server.request(owner, '/approvals/forms')).items.find(row => row.key === 'generic');
      const override = await server.request(owner, '/approvals/forms', 'POST', { key: 'generic', name: 'Changed', fields: [{ key: 'purpose', type: 'text', required: false }] }, 201);
      assert.equal(override.revision, original.revision + 1);
      await submit(draft, original.revision, 409);
      assert.equal((await server.request(owner, `/approvals/requests/${draft.id}`)).status, 'draft');
      assert.equal((await submit(draft, override.revision)).form_snapshot.revision, override.revision);
    });
  } finally {
    await server.close(); await mkdir(evidence, { recursive: true });
    await writeFile(new URL('revision-sqlite-http.json', evidence), JSON.stringify({ http: server.http, cleanup: server.resource }, null, 2));
  }
});
