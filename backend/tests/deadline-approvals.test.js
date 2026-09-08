import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { startDeadlineServer, evidenceBody } from './deadline-fixture.js';
import { createOwnerOrg } from './http.js';

const evidence = new URL('../../.omo/evidence/task-22-deadline-erp-redesign/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function sameCompanyActor(server, owner, label) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}@example.invalid`;
  const invite = await server.request(owner, '/members/invites', 'POST', { email, roles: ['company_admin'] }, 201);
  const signup = await server.request(null, '/auth/signup', 'POST', {
    name: label, email, password: 'password-1234', invitation_token: invite.token,
  }, 201);
  return { token: signup.access_token, orgId: owner.orgId, userId: signup.user.id };
}

async function uploadApproval(server, actor, bytes) {
  const response = await fetch(server.baseUrl + '/approvals/receipt-uploads', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${actor.token}`,
      'X-Org-Id': actor.orgId,
      'Content-Type': 'image/png',
      'X-Upload-Name': encodeURIComponent('결재증빙.png'),
    },
    body: bytes,
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(evidenceBody(body)));
  return body;
}

async function rawRequest(server, actor, route, method, body) {
  const response = await fetch(server.baseUrl + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${actor.token}`,
      'X-Org-Id': actor.orgId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('deadline approval API keeps drafts private and submitted snapshots immutable', async () => {
  process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'approval-receipts');
  await mkdir(evidence, { recursive: true });
  const server = await startDeadlineServer();
  const scenarios = [];
  try {
    const owner = await createOwnerOrg(server.baseUrl, ['approvals']);
    const decider = await sameCompanyActor(server, owner, 'Assigned decider');
    const bystander = await sameCompanyActor(server, owner, 'Unassigned administrator');
    const foreign = await createOwnerOrg(server.baseUrl, ['approvals']);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).png().toBuffer();

    const forms = await server.request(owner, '/approvals/forms');
    assert.deepEqual(forms.items.filter(form => form.builtin).map(form => form.key).sort(), ['expense_review', 'generic', 'purchase_request']);
    const generic = forms.items.find(form => form.key === 'generic');
    const invalidDraft = await server.request(owner, '/approvals/drafts', 'POST', {
      form_key: 'generic', title: '필수 목적 누락', body: {}, steps: [{ approver_id: decider.userId }],
    }, 201);
    const invalidStage = await uploadApproval(server, owner, png);
    await server.request(owner, `/approvals/requests/${invalidDraft.id}/submit`, 'POST', {
      expected_version: invalidDraft.version, form_revision: generic.revision, receipt_tokens: [invalidStage.token],
    }, 400);
    const { db, transaction } = await import('../src/config/db.js');
    assert.equal(db().prepare('SELECT status FROM approval WHERE id=?').get(invalidDraft.id).status, 'draft');
    assert.equal(db().prepare('SELECT state FROM receipt_upload WHERE token_hash=?').get(hash(invalidStage.token)).state, 'ready');
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM approval_receipt_files WHERE approval_id=?').get(invalidDraft.id).n, 0);

    const rollbackDraft = await server.request(owner, '/approvals/drafts', 'POST', {
      form_key: 'generic', title: '원자 제출', body: { purpose: 'rollback 검증' }, steps: [{ approver_id: decider.userId }],
    }, 201);
    const rollbackStage = await uploadApproval(server, owner, png);
    db().exec("CREATE TRIGGER fail_approval_submit BEFORE INSERT ON audit_event WHEN NEW.action='approval.submitted' BEGIN SELECT RAISE(ABORT,'approval submit audit failure'); END");
    try {
      await server.request(owner, `/approvals/requests/${rollbackDraft.id}/submit`, 'POST', {
        expected_version: rollbackDraft.version, form_revision: generic.revision, receipt_tokens: [rollbackStage.token],
      }, 500);
    } finally { db().exec('DROP TRIGGER fail_approval_submit'); }
    assert.equal(db().prepare('SELECT status FROM approval WHERE id=?').get(rollbackDraft.id).status, 'draft');
    assert.equal(db().prepare('SELECT state FROM receipt_upload WHERE token_hash=?').get(hash(rollbackStage.token)).state, 'ready');
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM approval_receipt_files WHERE approval_id=?').get(rollbackDraft.id).n, 0);

    const draft = await server.request(owner, '/approvals/drafts', 'POST', {
      form_key: 'generic', title: '', body: {}, steps: [{ approver_id: decider.userId }],
    }, 201);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.version, 1);
    assert.equal((await server.request(owner, '/approvals/requests?box=sent')).items.some(row => row.id === draft.id), true);
    assert.equal((await server.request(bystander, '/approvals/requests?box=inbox')).items.some(row => row.id === draft.id), false);
    await server.request(bystander, `/approvals/requests/${draft.id}`, 'GET', undefined, 404);
    await server.request(foreign, `/approvals/requests/${draft.id}`, 'GET', undefined, 404);

    const stalePatch = await rawRequest(server, owner, `/approvals/requests/${draft.id}/draft`, 'PATCH', {
      expected_version: 99, title: '출장 품의', body: { purpose: '고객 미팅' },
    });
    assert.equal(stalePatch.status, 409);
    const edited = await server.request(owner, `/approvals/requests/${draft.id}/draft`, 'PATCH', {
      expected_version: draft.version, title: '출장 품의', body: { purpose: '고객 미팅' },
    });
    const staged = await uploadApproval(server, owner, png);
    const badRevision = await rawRequest(server, owner, `/approvals/requests/${draft.id}/submit`, 'POST', {
      expected_version: edited.version, form_revision: generic.revision + 1, receipt_tokens: [staged.token],
    });
    assert.equal(badRevision.status, 409);
    assert.equal(db().prepare('SELECT state FROM receipt_upload WHERE token_hash=?').get(hash(staged.token)).state, 'ready');

    const submitted = await server.request(owner, `/approvals/requests/${draft.id}/submit`, 'POST', {
      expected_version: edited.version, form_revision: generic.revision, receipt_tokens: [staged.token],
    });
    assert.equal(submitted.status, 'pending');
    assert.equal(submitted.form_snapshot.revision, generic.revision);
    assert.equal(submitted.attachment_snapshot.length, 1);
    assert.equal(submitted.attachment_snapshot[0].checksum_sha256, hash(png));
    assert.deepEqual(submitted.body, { purpose: '고객 미팅' });
    assert.throws(() => db().prepare('UPDATE approval SET title=? WHERE id=?').run('직접 변조', draft.id), /snapshot is immutable/);

    await server.request(owner, `/approvals/requests/${draft.id}/draft`, 'PATCH', {
      expected_version: submitted.version, title: '변조',
    }, 409);
    const extra = await uploadApproval(server, owner, png);
    const principal = (await import('../src/middleware/auth.js')).resolvePrincipal({
      get: name => ({ authorization: `Bearer ${owner.token}`, 'x-org-id': owner.orgId })[name],
    });
    const receipts = await import('../src/services/legacy-receipt-files.service.js');
    assert.throws(() => transaction(() => receipts.consumeLegacyReceipts(principal, {
      kind: 'approval', parentId: draft.id, expectedVersion: submitted.version, tokens: [extra.token],
    }))(), { code: 'CONFLICT' });

    assert.equal((await server.request(bystander, '/approvals/requests?box=inbox')).items.some(row => row.id === draft.id), false);
    await server.request(bystander, `/approvals/requests/${draft.id}`, 'GET', undefined, 404);
    await server.request(bystander, `/approvals/requests/${draft.id}/history`, 'GET', undefined, 404);
    await server.request(bystander, `/approvals/requests/${draft.id}/receipts/${submitted.attachment_snapshot[0].file_id}`, 'GET', undefined, 404);
    const assignedDetail = await server.request(decider, `/approvals/requests/${draft.id}`);
    assert.equal(assignedDetail.id, draft.id);
    assert.equal((await server.request(decider, '/approvals/requests?box=inbox')).items.some(row => row.id === draft.id), true);
    assert.ok((await server.request(decider, `/approvals/requests/${draft.id}/history`)).items.length >= 2);
    const download = await fetch(server.baseUrl + `/approvals/requests/${draft.id}/receipts/${submitted.attachment_snapshot[0].file_id}`, {
      headers: { Authorization: `Bearer ${decider.token}`, 'X-Org-Id': decider.orgId }, signal: AbortSignal.timeout(10000),
    });
    assert.equal(download.status, 200);
    assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(png));

    await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'reject', comment: '   ' }, 400);
    const rejected = await server.request(decider, `/approvals/requests/${draft.id}/actions`, 'POST', { decision: 'reject', comment: '예산 근거 부족' });
    assert.equal(rejected.status, 'rejected');
    const resubmitted = await server.request(owner, `/approvals/requests/${draft.id}/resubmit`, 'POST', { expected_version: rejected.version }, 201);
    assert.notEqual(resubmitted.id, draft.id);
    assert.equal(resubmitted.predecessor_id, draft.id);
    assert.equal(resubmitted.status, 'draft');
    assert.deepEqual(resubmitted.attachment_snapshot, []);
    assert.equal((await server.request(owner, `/approvals/requests/${draft.id}`)).status, 'rejected');
    assert.throws(() => db().prepare('DELETE FROM approval_history WHERE approval_id=?').run(draft.id), /history is immutable/);

    scenarios.push({ case: 'private immutable draft-submit-reject-resubmit', request: draft.id, submittedVersion: submitted.version, rejectedVersion: rejected.version });

    const first = await sameCompanyActor(server, owner, 'First approver');
    const second = await sameCompanyActor(server, owner, 'Second approver');
    const immediate = await server.request(owner, '/approvals/requests', 'POST', {
      title: '기존 즉시 제출', amount: 1_000_000,
      steps: [{ approver_id: first.userId }, { approver_id: second.userId }],
    }, 201);
    assert.equal(immediate.status, 'pending');
    assert.equal(immediate.workflow_locked, false);
    await server.request(first, `/approvals/requests/${immediate.id}/actions`, 'POST', { decision: 'approve' }, 403);
    await server.request(first, `/approvals/requests/${immediate.id}/actions`, 'POST', { decision: 'hold', comment: '추가 확인' });
    await server.request(second, `/approvals/requests/${immediate.id}/actions`, 'POST', { decision: 'approve', reauth_password: 'password-1234' }, 409);
    await server.request(first, `/approvals/requests/${immediate.id}/actions`, 'POST', { decision: 'approve', reauth_password: 'password-1234' });
    const approved = await server.request(second, `/approvals/requests/${immediate.id}/actions`, 'POST', { decision: 'approve', reauth_password: 'password-1234' });
    assert.equal(approved.status, 'approved');

    const raced = await server.request(owner, '/approvals/requests', 'POST', {
      title: '결정 철회 경합', steps: [{ approver_id: first.userId }],
    }, 201);
    const outcomes = await Promise.all([
      rawRequest(server, first, `/approvals/requests/${raced.id}/actions`, 'POST', { decision: 'approve' }),
      rawRequest(server, owner, `/approvals/requests/${raced.id}/withdraw`, 'POST', {}),
    ]);
    assert.deepEqual(outcomes.map(row => row.status).sort(), [200, 409]);
    const final = await server.request(owner, `/approvals/requests/${raced.id}`);
    assert.ok(['approved', 'withdrawn'].includes(final.status));
    scenarios.push({ case: 'legacy immediate/reauth/held/CAS race', final: final.status });
  } finally {
    await writeFile(new URL('sqlite-http.json', evidence), JSON.stringify({ scenarios, http: server.http }, null, 2));
    await server.close();
  }
});
