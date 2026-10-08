import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';

describe('네이티브 PostgreSQL 에이전트 도메인', { timeout: 120000 }, () => {
  let fixture, credentialStore, capabilities, operations, closePgPool, context, projectId;
  before(async () => {
    fixture = await startDailyNativePostgres();
    // 기존 PG 공급자 키 연결의 auth_identity는 별도의 SQLite 인증 메타데이터다.
    credentialStore = await startTestServer();
    await fixture.pool.query(await readFile(new URL('../../db/perp_additions_v22_inapp_agent.sql', import.meta.url), 'utf8'));
    const userId = fixture.identity.users[0].id, companyId = fixture.companyId;
    const permissions = ['agent.chat', 'menu.agent', 'document.read', 'document.write', 'menu.documents',
      'transaction.read', 'budget.read', 'menu.finance'];
    await fixture.pool.query("INSERT INTO org.permissions(code,module,description) SELECT code,'agent',code FROM unnest($1::text[]) code ON CONFLICT DO NOTHING", [permissions]);
    await fixture.pool.query(`INSERT INTO org.role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM org.roles r CROSS JOIN org.permissions p WHERE r.company_id=$1 AND r.name='DAILY_TEST_ROLE' AND p.code=ANY($2::text[]) ON CONFLICT DO NOTHING`, [companyId, permissions]);
    await fixture.pool.query("INSERT INTO org.company_modules(company_id,module_key) SELECT $1,k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING", [companyId, ['agent', 'documents', 'finance']]);
    projectId = (await fixture.pool.query("INSERT INTO project.projects(company_id,name,lead_id) VALUES($1,'원장 프로젝트',$2) RETURNING id", [companyId, userId])).rows[0].id;
    await fixture.pool.query(`INSERT INTO public.agent_runs(id,company_id,actor_id,conversation_id,idempotency_key,request_hash,status)
      VALUES('pg-run',$1,$2,'pg-conversation','pg-run-key','hash','running')`, [companyId, userId]);
    capabilities = await import('../src/services/agent-capabilities.service.js');
    operations = await import('../src/services/agent-operation.service.js');
    ({ closePgPool } = await import('../src/config/pg.js'));
    context = { source: 'pg', knowledgeMode: 'personal', actorId: userId, workspaceId: companyId, request: {
      authSource: 'perp_db', externalIdentity: { subject: userId, companyId }, get: name => name.toLowerCase() === 'x-org-id' ? `pg:${companyId}` : undefined,
      requestId: 'native-domain',
    } };
  });
  after(async () => { await credentialStore?.close(); await closePgPool?.(); await fixture?.close(); });
  const propose = (call, tool, input) => operations.propose(context, { run_id: 'pg-run', tool_call_id: call, conversation_id: 'pg-conversation', tool, input });
  async function execute(call, tool, input) {
    const action = await propose(call, tool, input);
    const confirmed = await operations.confirmOperation(context, action.id, { expected_version: action.version });
    const result = await operations.executeOperation(context, action.id, { expected_version: confirmed.version }, `key-${call}`);
    assert.deepEqual(await operations.executeOperation(context, action.id, { expected_version: confirmed.version }, `key-${call}`), result);
    return result;
  }
  it('네 가지 실제 쓰기와 여덟 가지 읽기 및 정확한 영수증 재생', async () => {
    const before = Number((await fixture.pool.query('SELECT count(*) FROM project.tasks')).rows[0].count);
    const proposal = await propose('task', 'create.task', { title: 'PG 업무', project_id: projectId });
    assert.equal(proposal.provider_receipt.kind, 'operation_preview');
    assert.ok(!JSON.stringify(proposal.provider_receipt).includes('PG 업무'));
    assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM project.tasks')).rows[0].count), before);
    const task = await execute('task', 'create.task', { title: 'PG 업무', project_id: projectId });
    assert.equal(task.status, 'executed');
    assert.equal(task.result.title, 'PG 업무');
    assert.equal(proposal.id, task.id);
    const status = await execute('status', 'update.task_status', { task_id: task.result.id, status: 'done', expected_version: task.result.version });
    assert.equal(status.result.status, 'done');
    const event = await execute('event', 'create.event', { title: 'PG 일정', starts_at: '2026-09-10T01:00:00Z', ends_at: '2026-09-10T02:00:00Z' });
    assert.ok(event.result.id);
    const document = await execute('document', 'create.document', { title: 'PG 문서', content_md: '실제 본문', project_id: projectId });
    assert.ok(document.result.id);
    const tools = await capabilities.catalog(context);
    assert.equal(tools.filter(tool => tool.implemented && tool.stage === 'read').length, 8);
    assert.equal(tools.find(tool => tool.name === 'confirm.transaction').implemented, false);
    for (const name of ['search.tasks', 'search.documents', 'search.events', 'search.members', 'search.projects', 'search.transactions', 'get.brief', 'get.project_money']) {
      const value = await capabilities.query(context, name, name === 'get.project_money' ? { project_id: projectId } : {});
      assert.ok(Array.isArray(value.evidence), name);
      assert.equal(typeof value.truncated, 'boolean', name);
      assert.equal(value.provider_receipt.status, 'protected_result');
      assert.equal(value.classification, 'confidential');
      assert.ok(!JSON.stringify(value.provider_receipt).includes('실제 본문'));
    }
    assert.equal(Number((await fixture.pool.query("SELECT count(*) FROM org.daily_correction_events WHERE company_id=$1", [fixture.companyId])).rows[0].count), 4);
    const { db } = await import('../src/config/db.js');
    for (const table of ['task', 'event', 'document']) assert.equal(db().prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  });
  it('회사 조회는 비공개 일정과 개인 모드 영수증을 숨긴다', async () => {
    await fixture.pool.query(`INSERT INTO calendar.events(company_id,owner_id,title,starts_at,ends_at,scope)
      VALUES($1,$2,'PRIVATE_EVENT','2026-09-10T01:00Z','2026-09-10T02:00Z','private')`, [fixture.companyId, context.actorId]);
    const company = { ...context, knowledgeMode: 'company' };
    const value = await capabilities.query(company, 'search.events', { query: 'PRIVATE_EVENT' });
    assert.equal(value.result.items.length, 0);
    const proposal = await propose('mode-test', 'create.task', { title: '모드 격리', project_id: projectId });
    await assert.rejects(() => operations.getOperation(company, proposal.id), { code: 'NOT_FOUND' });
  });
  it('권한 철회, 다른 회사 ID, 오래된 버전, 동시 재생을 실제 잠금으로 검사한다', async () => {
    const foreignProject = (await fixture.pool.query("INSERT INTO project.projects(company_id,name) VALUES($1,'외부 회사') RETURNING id", [fixture.otherCompanyId])).rows[0].id;
    await assert.rejects(() => propose('foreign-project', 'create.task', { title: '거절', project_id: foreignProject }), { code: 'NOT_FOUND' });
    await assert.rejects(() => propose('foreign-member', 'create.task', { title: '거절', project_id: projectId, assignee_id: fixture.foreignId }), { code: 'PERMISSION_DENIED' });
    const action = await propose('concurrent', 'create.task', { title: '한 번만 생성', project_id: projectId });
    const confirmed = await operations.confirmOperation(context, action.id, { expected_version: 1 });
    const before = Number((await fixture.pool.query('SELECT count(*) FROM project.tasks')).rows[0].count);
    const [a, b] = await Promise.all([1, 2].map(() => operations.executeOperation(context, action.id, { expected_version: confirmed.version }, 'concurrent-key')));
    assert.deepEqual(a, b);
    assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM project.tasks')).rows[0].count), before + 1);
    const staleAction = await propose('stale', 'update.task_status', { task_id: a.result.id, status: 'done', expected_version: 1 });
    const staleConfirmed = await operations.confirmOperation(context, staleAction.id, { expected_version: 1 });
    await fixture.pool.query('UPDATE project.tasks SET version=version+1 WHERE id=$1', [a.result.id]);
    await assert.rejects(() => operations.executeOperation(context, staleAction.id, { expected_version: staleConfirmed.version }, 'stale-key'), { code: 'VERSION_CONFLICT' });
    const grant = (await fixture.pool.query(`DELETE FROM org.role_permissions rp USING org.roles r,org.permissions p
      WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.company_id=$1 AND r.name='DAILY_TEST_ROLE' AND p.code='task.write'
      RETURNING rp.role_id,rp.permission_id`, [fixture.companyId])).rows[0];
    try { await assert.rejects(() => operations.executeOperation(context, action.id, { expected_version: confirmed.version }, 'concurrent-key'), { code: 'PERMISSION_DENIED' }); }
    finally { await fixture.pool.query('INSERT INTO org.role_permissions(role_id,permission_id) VALUES($1,$2)', [grant.role_id, grant.permission_id]); }
    assert.deepEqual(await operations.executeOperation(context, action.id, { expected_version: confirmed.version }, 'concurrent-key'), a);
    await assert.rejects(() => fixture.pool.query("UPDATE public.agent_operations SET knowledge_mode='company' WHERE id=$1", [action.id]), /immutable/);
  });
  it('영수증 실패는 PG 업무와 도메인 감사 및 알림을 원자적으로 롤백한다', async () => {
    const action = await propose('rollback', 'create.task', { title: '롤백 업무', project_id: projectId });
    const confirmed = await operations.confirmOperation(context, action.id, { expected_version: 1 });
    const counts = async () => Promise.all(['project.tasks', 'org.daily_correction_events', 'notice.notifications']
      .map(async table => (await fixture.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count));
    const before = await counts();
    await fixture.pool.query(`CREATE FUNCTION public.fail_agent_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'receipt failure'; END; $$;
      CREATE TRIGGER fail_agent_receipt BEFORE UPDATE OF result_json ON public.agent_operations
      FOR EACH ROW EXECUTE FUNCTION public.fail_agent_receipt();`);
    try {
      await assert.rejects(() => operations.executeOperation(context, action.id, { expected_version: confirmed.version }, 'rollback-key'), /receipt failure/);
      assert.deepEqual(await counts(), before);
      assert.equal((await operations.getOperation(context, action.id)).status, 'confirmed');
    } finally {
      await fixture.pool.query('DROP TRIGGER fail_agent_receipt ON public.agent_operations; DROP FUNCTION public.fail_agent_receipt();');
    }
  });
  it('프로젝트 자금은 큰 소수 금액을 손실 없이 실제 원장에서 읽는다', async () => {
    await fixture.pool.query(`INSERT INTO accounting.budgets(company_id,project_id,name,amount,money_currency)
      VALUES($1,$2,'정확한 원장 예산',1234567890.12,'KRW')`, [fixture.companyId, projectId]);
    const result = await capabilities.query(context, 'get.project_money', { project_id: projectId });
    assert.equal(result.result.totals.find(total => total.unit === 'KRW').allocated, '1234567890.12');
    assert.equal(result.result.totals.find(total => total.unit === 'KRW').remaining, '1234567890.12');
  });
});
