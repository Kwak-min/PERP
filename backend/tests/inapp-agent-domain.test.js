import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, createOwnerOrg, startTestServer } from './http.js';
import { catalog, query } from '../src/services/agent-capabilities.service.js';
import { propose, confirmOperation, executeOperation, getOperation, cancelOperation } from '../src/services/agent-operation.service.js';
import { migrateInappAgent } from '../src/config/inapp-agent-migration.js';

describe('실제 SQLite 에이전트 도메인 경계', { timeout: 30000 }, () => {
  let server, actor, db, context;
  before(async () => {
    server = await startTestServer();
    actor = await createOwnerOrg(server.baseUrl, ['agent', 'tasks', 'projects', 'documents', 'calendar', 'finance', 'approvals']);
    ({ db } = await import('../src/config/db.js'));
    migrateInappAgent(db());
    context = { source: 'legacy', knowledgeMode: 'personal', request: {
      get(name) { return name.toLowerCase() === 'authorization' ? `Bearer ${actor.token}` : name.toLowerCase() === 'x-org-id' ? actor.orgId : undefined; },
      originalUrl: '/api/v1/agent/operations', method: 'POST', requestId: 'domain-test',
    } };
    const org = db().prepare('SELECT tenant_id FROM organization WHERE id=?').get(actor.orgId);
    db().prepare(`INSERT INTO agent_runs(id,tenant_id,org_id,actor_id,conversation_id,idempotency_key,request_hash,status,created_at,updated_at)
      VALUES('run',?,?,?,'conversation','run-key','hash','running',?,?)`).run(org.tenant_id, actor.orgId, actor.userId, new Date().toISOString(), new Date().toISOString());
  });
  it('회사 모드는 개인 문서와 개인 작업 영수증을 볼 수 없다', async () => {
    const document = await api(server.baseUrl, '/documents', { ...actor, method: 'POST',
      body: { title: 'PRIVATE_SENTINEL', content: 'private-only-value', visibility: 'private' } });
    assert.equal(document.status, 201);
    const personal = await query(context, 'search.documents', { query: 'PRIVATE_SENTINEL' });
    assert.equal(personal.result.items.length, 1);
    assert.equal(personal.classification, 'confidential');
    assert.equal(personal.provider_receipt.kind, 'protected_query');
    assert.equal(personal.provider_receipt.status, 'protected_result');
    assert.ok(!JSON.stringify(personal.provider_receipt).includes('PRIVATE_SENTINEL'));
    assert.ok(!JSON.stringify(personal.provider_receipt).includes('private-only-value'));
    const company = { ...context, knowledgeMode: 'company' };
    const hidden = await query(company, 'search.documents', { query: 'PRIVATE_SENTINEL' });
    assert.equal(hidden.result.items.length, 0);
    assert.ok(!JSON.stringify(hidden.provider_receipt).includes(document.body.id));
    const proposal = await propose(context, { run_id: 'run', tool_call_id: 'mode-test', conversation_id: 'conversation', tool: 'create.task', input: { title: '개인 제안' } });
    assert.equal(proposal.provider_receipt.id, proposal.id);
    assert.equal(proposal.provider_receipt.status, 'preview');
    assert.ok(!JSON.stringify(proposal.provider_receipt).includes('개인 제안'));
    await assert.rejects(() => getOperation(company, proposal.id), { code: 'NOT_FOUND' });
    await assert.rejects(() => propose(company, { run_id: 'run', tool_call_id: 'mode-test', conversation_id: 'conversation', tool: 'create.task', input: { title: '개인 제안' } }), { code: 'NOT_FOUND' });
  });
  it('완료 체크리스트, 오래된 업무 버전, 도구 자기확인과 실행 취소를 차단한다', async () => {
    const created = await api(server.baseUrl, '/tasks', { ...actor, method: 'POST', body: { title: '필수 확인 업무' } });
    assert.equal(created.status, 201);
    const item = await api(server.baseUrl, `/tasks/${created.body.id}/checklist`, { ...actor, method: 'POST', body: { label: '필수', required: true } });
    assert.equal(item.status, 201);
    const proposal = await propose(context, { run_id: 'run', tool_call_id: 'checklist', conversation_id: 'conversation', tool: 'update.task_status',
      input: { task_id: created.body.id, status: 'done', expected_version: 1 } });
    const confirmed = await confirmOperation(context, proposal.id, { expected_version: 1 });
    await assert.rejects(() => executeOperation(context, proposal.id, { expected_version: confirmed.version }, 'blocked-completion'), { code: 'CONFLICT' });
    assert.equal(db().prepare('SELECT status FROM task WHERE id=?').get(created.body.id).status, 'todo');
    const cancelled = await cancelOperation(context, proposal.id, { expected_version: confirmed.version });
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(() => executeOperation(context, proposal.id, { expected_version: cancelled.version }, 'cancelled-execution'), { code: 'CONFLICT' });
    await assert.rejects(() => query(context, 'create.task', { title: 'self-confirm' }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => propose(context, { run_id: 'run', tool_call_id: 'self-confirm', conversation_id: 'conversation', tool: 'create.task',
      input: { title: 'self-confirm', confirmed: true } }), { code: 'VALIDATION_ERROR' });
    const toggled = await api(server.baseUrl, `/tasks/${created.body.id}/checklist/${item.body.id}/toggle`, { ...actor, method: 'POST', body: {} });
    assert.equal(toggled.status, 200);
    const next = await propose(context, { run_id: 'run', tool_call_id: 'completed', conversation_id: 'conversation', tool: 'update.task_status',
      input: { task_id: created.body.id, status: 'done', expected_version: 1 } });
    const ready = await confirmOperation(context, next.id, { expected_version: 1 });
    const completed = await executeOperation(context, next.id, { expected_version: ready.version }, 'completed-key');
    assert.equal(completed.result.status, 'done');
    assert.equal(completed.result.version, 2);
  });
  after(async () => { await server?.close(); });
  it('외부 ID, 누락된 실행, 변경된 호출 입력은 제안 단계에서 거절한다', async () => {
    await assert.rejects(() => propose(context, { run_id: 'missing-run', tool_call_id: 'foreign', conversation_id: 'conversation', tool: 'create.task', input: { title: '외부' } }), { code: 'NOT_FOUND' });
    await assert.rejects(() => propose(context, { run_id: 'run', tool_call_id: 'foreign-project', conversation_id: 'conversation', tool: 'create.task',
      input: { title: '외부 프로젝트', project_id: 'foreign-project' } }), { code: 'NOT_FOUND' });
    await assert.rejects(() => propose(context, { run_id: 'run', tool_call_id: 'foreign-assignee', conversation_id: 'conversation', tool: 'create.task',
      input: { title: '외부 구성원', assignee_id: 'foreign-user' } }), { code: 'PERMISSION_DENIED' });
    const payload = { run_id: 'run', tool_call_id: 'dedupe', conversation_id: 'conversation', tool: 'create.task', input: { title: '중복 방지' } };
    const first = await propose(context, payload);
    assert.deepEqual(await propose(context, payload), first);
    await assert.rejects(() => propose(context, { ...payload, input: { title: '변경된 입력' } }), { code: 'CONFLICT' });
    assert.throws(() => db().prepare("UPDATE agent_operations SET knowledge_mode='company' WHERE id=?").run(first.id), /immutable/);
  });
  it('영수증 실패는 업무, 알림, 감사 로그를 함께 롤백한다', async () => {
    const action = await propose(context, { run_id: 'run', tool_call_id: 'atomic', conversation_id: 'conversation', tool: 'create.task', input: { title: '원자성' } });
    const confirmed = await confirmOperation(context, action.id, { expected_version: 1 });
    const count = table => db().prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const before = ['task', 'notification', 'audit_event'].map(count);
    db().exec(`CREATE TRIGGER fail_operation_receipt BEFORE UPDATE OF result_json ON agent_operations
      BEGIN SELECT RAISE(ABORT,'receipt failure'); END;`);
    try {
      await assert.rejects(() => executeOperation(context, action.id, { expected_version: confirmed.version }, 'atomic-key'), /receipt failure/);
      assert.deepEqual(['task', 'notification', 'audit_event'].map(count), before);
      assert.equal((await getOperation(context, action.id)).status, 'confirmed');
    } finally { db().exec('DROP TRIGGER fail_operation_receipt'); }
    const receipt = await executeOperation(context, action.id, { expected_version: confirmed.version }, 'atomic-key');
    const org = db().prepare('SELECT modules FROM organization WHERE id=?').get(actor.orgId);
    db().prepare('UPDATE organization SET modules=? WHERE id=?').run(org.modules.split(',').filter(module => module !== 'tasks').join(','), actor.orgId);
    try {
      await assert.rejects(() => executeOperation(context, action.id, { expected_version: confirmed.version }, 'atomic-key'), { code: 'PERMISSION_DENIED' });
    } finally { db().prepare('UPDATE organization SET modules=? WHERE id=?').run(org.modules, actor.orgId); }
    assert.deepEqual(await executeOperation(context, action.id, { expected_version: confirmed.version }, 'atomic-key'), receipt);
  });
  it('금융 제안은 승인 요청을 보내지 않고 승인 재인증 기간 잠금을 모두 검사한다', async () => {
    const account = await api(server.baseUrl, '/finance/accounts', { ...actor, method: 'POST', body: { code: 'AGENT_TEST', name: '검증 계정', kind: 'expense' } });
    assert.equal(account.status, 201);
    const tx = await api(server.baseUrl, '/finance/transactions', { ...actor, method: 'POST',
      body: { kind: 'expense', amount_minor: 12345, occurred_on: '2026-09-10', account_id: account.body.id, memo: '검증 금액' } });
    assert.equal(tx.status, 201);
    const before = db().prepare('SELECT count(*) AS n FROM approval').get().n;
    const action = await propose(context, { run_id: 'run', tool_call_id: 'finance', conversation_id: 'conversation', tool: 'confirm.transaction',
      input: { transaction_id: tx.body.id, expected_version: tx.body.version } });
    assert.equal(db().prepare('SELECT count(*) AS n FROM approval').get().n, before);
    assert.equal(action.requires_reauth, true);
    await assert.rejects(() => confirmOperation(context, action.id, { expected_version: 1, approver_id: 'foreign-user' }), { code: 'VALIDATION_ERROR' });
    const confirmed = await confirmOperation(context, action.id, { expected_version: 1, approver_id: actor.userId });
    assert.equal(confirmed.approval_status, 'pending');
    await assert.rejects(() => executeOperation(context, action.id, { expected_version: confirmed.version }, 'finance-key'), { code: 'REAUTH_REQUIRED' });
    await assert.rejects(() => executeOperation(context, action.id, { expected_version: confirmed.version, reauth_password: 'password-1234' }, 'finance-key'), { code: 'APPROVAL_REQUIRED' });
    const approval = await api(server.baseUrl, `/approvals/requests/${confirmed.approval_id}/actions`, { ...actor, method: 'POST', body: { decision: 'approve', comment: '' } });
    assert.equal(approval.status, 200);
    const close = await api(server.baseUrl, '/finance/close', { ...actor, method: 'POST', body: { period: '2026-09' } });
    assert.equal(close.status, 200);
    const lock = db().prepare("SELECT id FROM fiscal_period_lock WHERE org_id=? AND period='2026-09'").get(actor.orgId);
    await assert.rejects(() => executeOperation(context, action.id, { expected_version: confirmed.version, reauth_password: 'password-1234' }, 'finance-key'), { code: 'PERIOD_LOCKED' });
    db().prepare("UPDATE fiscal_period_lock SET status='open' WHERE id=?").run(lock.id);
    const executed = await executeOperation(context, action.id, { expected_version: confirmed.version, reauth_password: 'password-1234' }, 'finance-key');
    assert.equal(executed.result.status, 'confirmed');
    assert.equal(executed.result.amount_minor, 12345);
    assert.equal(db().prepare('SELECT approval_id FROM transaction_record WHERE id=?').get(tx.body.id).approval_id, confirmed.approval_id);
    assert.ok(!JSON.stringify(db().prepare('SELECT * FROM audit_event').all()).includes('password-1234'));
    const rejectedTx = await api(server.baseUrl, '/finance/transactions', { ...actor, method: 'POST',
      body: { kind: 'expense', amount_minor: 100, occurred_on: '2026-09-10', account_id: account.body.id, memo: '반려 검증' } });
    assert.equal(rejectedTx.status, 201);
    const rejected = await propose(context, { run_id: 'run', tool_call_id: 'rejected', conversation_id: 'conversation', tool: 'confirm.transaction',
      input: { transaction_id: rejectedTx.body.id, expected_version: rejectedTx.body.version } });
    const rejectedConfirmed = await confirmOperation(context, rejected.id, { expected_version: 1, approver_id: actor.userId });
    const rejection = await api(server.baseUrl, `/approvals/requests/${rejectedConfirmed.approval_id}/actions`, { ...actor, method: 'POST', body: { decision: 'reject', comment: '반려' } });
    assert.equal(rejection.status, 200);
    assert.equal((await getOperation(context, rejected.id)).can_execute, false);
    await assert.rejects(() => executeOperation(context, rejected.id, { expected_version: rejectedConfirmed.version, reauth_password: 'password-1234' }, 'rejected-key'), { code: 'APPROVAL_REQUIRED' });
  });
  it('문서 버전 색인과 일정 참석자 및 실제 여덟 읽기를 유지한다', async () => {
    async function execute(call, tool, input) {
      const action = await propose(context, { run_id: 'run', tool_call_id: call, conversation_id: 'conversation', tool, input });
      const confirmed = await confirmOperation(context, action.id, { expected_version: 1 });
      return executeOperation(context, action.id, { expected_version: confirmed.version }, `${call}-key`);
    }
    const document = await execute('document', 'create.document', { title: '색인 문서', content: '문단 하나\n\n문단 둘' });
    assert.equal(db().prepare('SELECT count(*) AS n FROM document_version WHERE document_id=?').get(document.result.id).n, 1);
    assert.equal(db().prepare('SELECT count(*) AS n FROM document_chunk WHERE document_id=?').get(document.result.id).n, 2);
    const event = await execute('event', 'create.event', { title: '참석자 일정', start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z', attendee_ids: [actor.userId] });
    assert.equal(db().prepare('SELECT count(*) AS n FROM event_attendee WHERE event_id=?').get(event.result.id).n, 1);
    const project = await api(server.baseUrl, '/projects', { ...actor, method: 'POST', body: { name: '정확한 자금 프로젝트' } });
    assert.equal(project.status, 201);
    for (const name of ['search.tasks', 'search.documents', 'search.events', 'search.members', 'search.projects', 'search.transactions', 'get.brief', 'get.project_money']) {
      const result = await query(context, name, name === 'get.project_money' ? { project_id: project.body.id } : {});
      assert.ok(Array.isArray(result.evidence), name);
    }
  });
  it('가용 기능은 실제 구현만 표시하고 모델 제안은 업무를 생성하지 않는다', async () => {
    const tools = await catalog(context);
    assert.equal(tools.find(tool => tool.name === 'create.task').callable, true);
    assert.equal(tools.find(tool => tool.name === 'delete.task').implemented, false);
    const beforeCount = db().prepare('SELECT count(*) AS n FROM task').get().n;
    const action = await propose(context, { run_id: 'run', tool_call_id: 'call', conversation_id: 'conversation', tool: 'create.task', input: { title: '실제 생성 확인' } });
    assert.equal(action.status, 'preview');
    assert.equal(db().prepare('SELECT count(*) AS n FROM task').get().n, beforeCount);
    await assert.rejects(() => executeOperation(context, action.id, { expected_version: action.version }, 'execution-key'), { code: 'CONFLICT' });
    const confirmed = await confirmOperation(context, action.id, { expected_version: action.version });
    const executed = await executeOperation(context, action.id, { expected_version: confirmed.version }, 'execution-key');
    assert.equal(executed.status, 'executed');
    assert.equal(db().prepare('SELECT count(*) AS n FROM task').get().n, beforeCount + 1);
    assert.deepEqual(await executeOperation(context, action.id, { expected_version: confirmed.version }, 'execution-key'), executed);
    const observed = await query(context, 'search.tasks', { query: '실제 생성 확인' });
    assert.ok(observed.result.items.some(item => item.id === executed.result.id));
    assert.equal((await api(server.baseUrl, `/tasks/${executed.result.id}`, actor)).status, 200);
  });
});
