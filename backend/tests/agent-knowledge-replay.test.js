import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';

test('knowledge replay ignores ranking churn but rechecks exact canonical sources and access', { timeout: 30000 }, async () => {
  let server;
  let calls = 0;
  const wire = createServer(async (req, res) => {
    let raw = '';
    for await (const bytes of req) raw += bytes;
    const body = JSON.parse(raw);
    calls += 1;
    const content = body.response_format?.json_schema?.name === 'knowledge_notes' ? '{"notes":[]}' : 'REPLAY_RESULT';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }], model: 'replay-loopback' }));
  });
  try {
    const listening = once(wire, 'listening', { signal: AbortSignal.timeout(5000) });
    wire.listen(0, '127.0.0.1');
    await listening;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}`;
    process.env.OPENROUTER_API_KEY = 'synthetic-replay-key';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
    server = await startTestServer();
    const actor = await createOwnerOrg(server.baseUrl, ['agent', 'documents']);
    const other = await createOwnerOrg(server.baseUrl, ['agent', 'documents']);
    const { db } = await import('../src/config/db.js');
    const { insert } = await import('../src/models/base.js');
    const { resolvePrincipal } = await import('../src/middleware/auth.js');
    const { prepareKnowledge } = await import('../src/services/agent-knowledge-prepare.service.js');
    const tenantId = db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(actor.orgId).tenant_id;
    const common = { tenant_id: tenantId, org_id: actor.orgId, owner_id: actor.userId, created_by: actor.userId };
    const document = insert('document', { ...common, title: 'Original company', content: 'COMPANY_ORIGINAL ' + 'x'.repeat(6500), sensitivity: 'internal', visibility: 'org' });
    const note = insert('vault_note', { ...common, title: 'Original personal', content: 'PERSONAL_ORIGINAL', sensitivity: 'personal', agent_enabled: 1 });
    const memory = insert('agent_memory', { ...common, content: 'MEMORY_ORIGINAL', sensitivity: 'personal' });
    const request = (route, options = {}) => api(server.baseUrl, `/agent${route}`, { ...actor, ...options });
    const attachment = await request('/attachments', { method: 'POST', body: {
      knowledge_mode: 'personal', filename: 'original.txt', mime: 'text/plain', content_base64: Buffer.from('ATTACHMENT_ORIGINAL').toString('base64'),
    } });
    assert.equal(attachment.status, 201, JSON.stringify(attachment.body));
    const input = { message: 'REPLAY_RELEVANCE', knowledge_mode: 'personal', attachment_ids: [attachment.body.id] };
    const options = { method: 'POST', headers: { 'Idempotency-Key': 'knowledge-replay' }, body: { ...input, agent_mode: true } };
    const preview = await request('/knowledge/consent-preview', { method: 'POST', body: input });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const original = await request('/chat', { ...options, body: { ...options.body, cloud_consent: { token: preview.body.token, confirmed: true } } });
    assert.equal(original.status, 200, JSON.stringify(original.body));
    assert.deepEqual(new Set(original.body.answer.evidence.map(row => row.type)), new Set(['document', 'vault_note', 'memory', 'attachment']));
    const callCount = calls;
    for (let i = 0; i < 12; i += 1) {
      insert('document', { ...common, title: `REPLAY_RELEVANCE ${i}`, content: 'NEW_COMPANY', sensitivity: 'internal', visibility: 'org' });
      insert('vault_note', { ...common, title: `REPLAY_RELEVANCE ${i}`, content: 'NEW_PERSONAL', sensitivity: 'personal', agent_enabled: 1 });
      insert('agent_memory', { ...common, content: 'NEW_MEMORY', sensitivity: 'personal', created_at: '2099-01-01T00:00:00.000Z' });
    }
    const headers = { authorization: `Bearer ${actor.token}`, 'x-org-id': actor.orgId };
    const req = { get: name => headers[name.toLowerCase()] };
    const principal = resolvePrincipal(req);
    const context = { source: 'legacy', request: req, principal, actorId: actor.userId, workspaceId: actor.orgId, knowledgeMode: 'personal' };
    const fresh = await prepareKnowledge(context, { message: input.message, attachment_ids: input.attachment_ids });
    for (const id of [`document:${document.id}`, `note:${note.id}`, `memory:${memory.id}`]) assert.ok(!fresh.evidence.some(row => row.id === id));
    const replay = await request('/chat', options);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, original.body);
    assert.equal(calls, callCount);

    const mutate = async (table, id, patch) => {
      const before = db().prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      const keys = Object.keys(patch);
      const update = db().prepare(`UPDATE ${table} SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=?`);
      update.run(...Object.values(patch), id);
      try {
        const denied = await request('/chat', options);
        assert.ok([403, 404, 409].includes(denied.status), `${table} ${keys}: ${JSON.stringify(denied)}`);
        assert.ok(['KNOWLEDGE_SCOPE_CHANGED', 'PERMISSION_DENIED', 'MODULE_DISABLED', 'NOT_FOUND', 'NO_ORGANIZATION'].includes(denied.body.error.code));
        assert.equal(calls, callCount, 'invalid replay must never call a provider');
      } finally { update.run(...keys.map(key => before[key]), id); }
    };
    for (const patch of [{ version: 2 }, { title: 'Changed' }, { content: document.content + 'TAIL_CHANGED' },
      { archived: 1 }, { deleted_at: '2000-01-01' }, { sensitivity: 'confidential' },
      { visibility: 'private', owner_id: other.userId }, { org_id: other.orgId }]) await mutate('document', document.id, patch);
    for (const patch of [{ version: 2 }, { content: 'Changed' }, { owner_id: other.userId },
      { agent_enabled: 0 }, { deleted_at: '2000-01-01' }, { org_id: other.orgId }]) await mutate('vault_note', note.id, patch);
    for (const patch of [{ version: 2 }, { content: 'Changed' }, { owner_id: other.userId },
      { expires_at: '2000-01-01' }, { deleted_at: '2000-01-01' }]) await mutate('agent_memory', memory.id, patch);
    for (const patch of [{ filename: 'Changed.txt' }, { extracted_text: 'Changed' }, { content_hash: 'changed' },
      { actor_id: other.userId }, { workspace_id: other.orgId }, { knowledge_mode: 'company' }]) await mutate('agent_knowledge_attachment', attachment.body.id, patch);
    await mutate('organization', actor.orgId, { modules: 'agent' });
    const membership = db().prepare('SELECT id FROM membership WHERE user_id=? AND org_id=?').get(actor.userId, actor.orgId);
    await mutate('membership', membership.id, { roles: '' });
    await mutate('membership', membership.id, { status: 'inactive' });
    assert.deepEqual((await request('/chat', options)).body, original.body);
    // Deletion also blocks reuse of the old answer as conversation history.
    db().prepare('DELETE FROM agent_knowledge_attachment WHERE id=?').run(attachment.body.id);
    assert.equal((await request('/chat', options)).status, 404);
    const continued = await request('/chat', { method: 'POST', headers: { 'Idempotency-Key': 'deleted-source-history' },
      body: { message: 'Continue', knowledge_mode: 'personal', agent_mode: true, conversation_id: original.body.conversation_id } });
    assert.equal(continued.status, 404);
    assert.equal(calls, callCount);
  } finally {
    await server?.close();
    await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  }
});
