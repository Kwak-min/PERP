import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';
import { migrateInappAgent } from '../src/config/inapp-agent-migration.js';
import { propose, confirmOperation, executeOperation } from '../src/services/agent-operation.service.js';

test('private operation document retains its body without leaking it into shared audit', { timeout: 30000 }, async t => {
  const server = await startTestServer();
  t.after(() => server.close());
  const owner = await createOwnerOrg(server.baseUrl, ['agent', 'documents', 'integrations']);
  const email = `auditor-${crypto.randomUUID()}@example.com`;
  const invitation = await api(server.baseUrl, '/members/invites', { ...owner, method: 'POST', body: { email, roles: ['org_admin'] } });
  assert.equal(invitation.status, 201);
  const signup = await api(server.baseUrl, '/auth/signup', { method: 'POST',
    body: { email, name: 'Audit reader', password: 'password-1234', invitation_token: invitation.body.token } });
  assert.equal(signup.status, 201);
  const auditor = { token: signup.body.access_token, userId: signup.body.user.id, orgId: owner.orgId };
  assert.notEqual(auditor.userId, owner.userId);

  const { db } = await import('../src/config/db.js');
  migrateInappAgent(db());
  const { tenant_id: tenantId } = db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(owner.orgId);
  const now = new Date().toISOString();
  db().prepare(`INSERT INTO agent_runs(id,tenant_id,org_id,actor_id,conversation_id,idempotency_key,request_hash,status,created_at,updated_at,knowledge_mode)
    VALUES('audit-run',?,?,?,'audit-conversation','audit-run-key','hash','running',?,?,'personal')`)
    .run(tenantId, owner.orgId, owner.userId, now, now);
  const context = { source: 'legacy', knowledgeMode: 'personal', request: {
    get(name) { return name.toLowerCase() === 'authorization' ? `Bearer ${owner.token}` : name.toLowerCase() === 'x-org-id' ? owner.orgId : undefined; },
    originalUrl: '/api/v1/agent/operations', method: 'POST', requestId: 'private-document-audit-test',
  } };
  const sentinel = 'PRIVATE_DOCUMENT_BODY_st_01a08909';
  const input = { title: 'Private audit regression', content: `First private paragraph\n\n${sentinel}\n\nLast private paragraph`, visibility: 'private' };
  const proposal = await propose(context, { run_id: 'audit-run', tool_call_id: 'private-document',
    conversation_id: 'audit-conversation', tool: 'create.document', input });
  assert.equal(proposal.status, 'preview');
  assert.equal(db().prepare('SELECT count(*) AS n FROM document').get().n, 0);
  const confirmed = await confirmOperation(context, proposal.id, { expected_version: proposal.version });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(db().prepare('SELECT count(*) AS n FROM document').get().n, 0);
  const executed = await executeOperation(context, proposal.id, { expected_version: confirmed.version }, 'private-document-key');
  assert.equal(executed.status, 'executed');
  assert.equal(executed.result.content, input.content);
  const document = db().prepare('SELECT * FROM document WHERE id=?').get(executed.result.id);
  assert.equal(document.content, input.content);
  assert.equal(document.visibility, 'private');
  assert.equal(document.owner_id, owner.userId);
  const versions = db().prepare('SELECT revision,content FROM document_version WHERE document_id=? ORDER BY revision').all(document.id);
  assert.deepEqual(versions.map(row => ({ ...row })), [{ revision: 1, content: input.content }]);
  const chunks = db().prepare('SELECT content,visibility FROM document_chunk WHERE document_id=? ORDER BY ordinal').all(document.id);
  assert.deepEqual(chunks.map(row => row.content), input.content.split('\n\n'));
  assert.ok(chunks.every(row => row.visibility === 'private'));
  const detail = await api(server.baseUrl, `/documents/${document.id}`, owner);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.content, input.content);
  assert.equal((await api(server.baseUrl, `/documents/${document.id}`, auditor)).status, 404);

  const canonical = await api(server.baseUrl, '/documents', { ...owner, method: 'POST', body: input });
  assert.equal(canonical.status, 201);
  const shared = await api(server.baseUrl, '/integrations/audit', auditor);
  assert.equal(shared.status, 200);
  const event = shared.body.items.find(row => row.action === 'document.created' && row.resource_id === document.id);
  const canonicalEvent = shared.body.items.find(row => row.action === 'document.created' && row.resource_id === canonical.body.id);
  assert.ok(event);
  assert.ok(canonicalEvent);
  assert.equal(JSON.stringify(shared.body).includes(sentinel), false, 'shared audit must not contain the private document body');
  assert.deepEqual(event.after, canonicalEvent.after);
  assert.deepEqual(event.after, { title: input.title });
  assert.equal(event.before, null);
  assert.equal(event.resource_type, 'document');
  assert.equal(event.actor_id, owner.userId);
  assert.equal(event.request_id, context.request.requestId);
  assert.equal(event.ai_generated, true);
  assert.equal(event.approval_id, null);
  const storedAudit = db().prepare('SELECT * FROM audit_event WHERE tenant_id=?').all(tenantId);
  assert.equal(JSON.stringify(storedAudit).includes(sentinel), false, 'private content must never enter persisted audit');
  const chain = await api(server.baseUrl, '/integrations/audit/verify', auditor);
  assert.equal(chain.status, 200);
  assert.equal(chain.body.valid, true);
});
