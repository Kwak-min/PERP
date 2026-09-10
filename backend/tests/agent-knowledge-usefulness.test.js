import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startTestServer, createOwnerOrg } from './http.js';

test('scoped knowledge remains recallable without literal wording and rejects request-only notes', async () => {
  const server = await startTestServer();
  try {
    const actor = await createOwnerOrg(server.baseUrl, ['agent', 'documents']);
    const other = await createOwnerOrg(server.baseUrl, ['agent', 'documents']);
    const { resolvePrincipal } = await import('../src/middleware/auth.js');
    const { insert } = await import('../src/models/base.js');
    const { db } = await import('../src/config/db.js');
    const knowledge = await import('../src/services/agent-knowledge.service.js');
    const headers = { authorization: `Bearer ${actor.token}`, 'x-org-id': actor.orgId };
    const request = { get: name => headers[name.toLowerCase()], requestId: randomUUID() };
    const principal = resolvePrincipal(request);
    const context = mode => ({ source: 'legacy', request, principal, actorId: principal.userId,
      workspaceId: principal.orgId, knowledgeMode: mode, requestId: request.requestId });
    const common = { tenant_id: principal.tenantId, org_id: principal.orgId, created_by: principal.userId };
    insert('document', { ...common, title: '정산 절차', content: 'COMPANY_RECALL 증빙은 금요일 오전에 대조한다.',
      visibility: 'org', sensitivity: 'internal', owner_id: principal.userId });
    insert('vault_note', { ...common, title: '준비 습관', content: 'PERSONAL_RECALL 회의 자료는 전날 저녁 읽는다.',
      owner_id: principal.userId, sensitivity: 'personal', agent_enabled: 1 });
    insert('vault_note', { ...common, title: '다른 사람', content: 'OTHER_OWNER_RECALL',
      owner_id: other.userId, sensitivity: 'personal', agent_enabled: 1 });
    insert('document', { ...common, title: '보호 자료', content: 'CONFIDENTIAL_RECALL',
      owner_id: principal.userId, visibility: 'org', sensitivity: 'confidential' });
    const message = '우리의 규정과 내 작업 방식을 함께 알려줘';
    const personal = await knowledge.prepareKnowledge(context('personal'), { message });
    assert.ok(personal.evidence.some(row => row.text.includes('COMPANY_RECALL')));
    assert.ok(personal.evidence.some(row => row.text.includes('PERSONAL_RECALL')));
    assert.ok(!JSON.stringify(personal).includes('OTHER_OWNER_RECALL'));
    assert.ok(!JSON.stringify(personal).includes('CONFIDENTIAL_RECALL'));
    const company = await knowledge.prepareKnowledge(context('company'), { message });
    assert.ok(company.evidence.some(row => row.text.includes('COMPANY_RECALL')));
    assert.ok(!JSON.stringify(company).includes('PERSONAL_RECALL'));

    const count = () => db().prepare('SELECT count(*) AS n FROM document WHERE org_id=?').get(actor.orgId).n;
    const lookup = '회사 운영 원칙만 찾아 설명해주세요.';
    const before = count();
    const prepared = await knowledge.prepareKnowledge(context('company'), { message: lookup });
    const rejected = await knowledge.extractAndSaveKnowledge(context('company'), {
      run_id: randomUUID(), message: lookup, prepared,
    }, { completeTurn: async () => ({ content: JSON.stringify({ notes: [
      { useful: true, kind: 'procedure', title: '조회 요청', source_id: 'user:current', quote: lookup },
    ] }) }) });
    assert.ok(!rejected.some(row => row.status === 'saved'));
    assert.equal(count(), before);
    const prohibition = '직접 실행하지 마세요.';
    const prohibited = await knowledge.prepareKnowledge(context('company'), { message: prohibition });
    const notDecision = await knowledge.extractAndSaveKnowledge(context('company'), {
      run_id: randomUUID(), message: prohibition, prepared: prohibited,
    }, { completeTurn: async () => ({ content: JSON.stringify({ notes: [
      { useful: true, kind: 'decision', title: '실행 지시', source_id: 'user:current', quote: prohibition },
    ] }) }) });
    assert.ok(!notDecision.some(row => row.status === 'saved'));
    assert.equal(count(), before);

    // Exact multi-sentence quote persisted by real-provider probe eeb66fde.
    const operational = "먼저 프로젝트 목록에서 '합성 프로젝트 legacy_eeb66fde'를 조회하세요. 찾은 실제 프로젝트 ID를 사용해 'PROBE_TASK_legacy_eeb66fde' 업무를 나에게 배정하는 생성 초안만 제안하세요. 직접 실행하지 마세요.";
    for (const mode of ['company', 'personal']) {
      const fact = mode === 'company' ? '검토 기록은 삼 년 동안 보관한다.' : '나는 회의 자료를 전날 읽는다.';
      const ctx = context(mode);
      const cases = [
        { message: operational, quote: operational },
        { message: operational, quote: operational.slice(20, -4) },
        { message: `${fact}\n${operational}`, quote: `${fact}\n${operational}` },
        { message: `Please search projects. Then show tasks.`, quote: `Please search projects. Then show tasks.` },
        { message: `Please create a task called REPEATED_QUOTE.\nREPEATED_QUOTE is temporary.`, quote: 'REPEATED_QUOTE' },
      ];
      for (const { message, quote } of cases) {
        const prepared = await knowledge.prepareKnowledge(ctx, { message });
        const receipts = await knowledge.extractAndSaveKnowledge(ctx, {
          run_id: randomUUID(), message, prepared,
        }, { completeTurn: async () => ({ content: JSON.stringify({ notes: [
          { useful: true, kind: 'procedure', title: '업무 배정 절차', source_id: 'user:current', quote },
        ] }) }) });
        assert.deepEqual(receipts.map(row => [row.status, row.code]), [['skipped', 'NO_USEFUL_KNOWLEDGE']], `${mode}: ${quote}`);
      }
      const message = `${fact}\n${operational}`;
      const prepared = await knowledge.prepareKnowledge(ctx, { message });
      const receipts = await knowledge.extractAndSaveKnowledge(ctx, {
        run_id: randomUUID(), message, prepared,
      }, { completeTurn: async () => ({ content: JSON.stringify({ notes: [
        { useful: true, kind: 'requirement', title: '검토 기록 보관', source_id: 'user:current', quote: fact },
      ] }) }) });
      assert.equal(receipts[0].status, 'saved', JSON.stringify(receipts));
      const table = mode === 'company' ? 'document' : 'vault_note';
      const row = db().prepare(`SELECT content FROM ${table} WHERE id=?`).get(receipts[0].id);
      assert.ok(row.content.includes(fact));
      assert.ok(!row.content.includes('PROBE_TASK_legacy_eeb66fde'));
    }

    const statement = '보고서는 오 년 동안 보관한다. 이 내용을 기억해 주세요.';
    const useful = await knowledge.prepareKnowledge(context('company'), { message: statement });
    const saved = await knowledge.extractAndSaveKnowledge(context('company'), {
      run_id: randomUUID(), message: statement, prepared: useful,
    }, { completeTurn: async () => ({ content: JSON.stringify({ notes: [
      { useful: true, kind: 'requirement', title: '보고서 보관', source_id: 'user:current', quote: '보고서는 오 년 동안 보관한다.' },
    ] }) }) });
    assert.ok(saved.some(row => row.status === 'saved'));
    assert.equal(count(), before + 2);
    const note = db().prepare('SELECT content FROM document WHERE id=?').get(saved.find(row => row.status === 'saved').id);
    assert.ok(note.content.includes('보고서는 오 년 동안 보관한다.'));
    assert.ok(!note.content.includes('기억해 주세요'));
  } finally { await server.close(); }
});
