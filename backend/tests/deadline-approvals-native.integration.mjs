import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { startTestServer } from './http.js';

assert.equal(process.env.DEADLINE_ISOLATED, '1');
process.env.PG_CONNECTION_TIMEOUT_MS = '10000';
process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'approval-native-receipts');
const evidence = new URL('../../.omo/evidence/task-22-deadline-erp-redesign/', import.meta.url);
await mkdir(evidence, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = await startDailyNativePostgres();
let server, closePgPool, passed = false;
const scenarios = [], cleanup = { serverClosed: false, nativeClosed: false };
try {
  cleanup.native = (await native.pool.query("SELECT split_part(pg_read_file('postmaster.pid'),chr(10),1)::int AS pid,current_setting('port')::int AS port,current_setting('data_directory') AS directory")).rows[0];
  for (const name of ['perp_additions_v12_deadline_expenses.sql', 'perp_additions_v13_approval_states.sql', 'perp_additions_v14_approval_details.sql']) {
    await native.pool.query(await readFile(new URL(`../../db/${name}`, import.meta.url), 'utf8'));
  }
  await native.pool.query(await readFile(new URL('../../db/perp_additions_v14_approval_details.sql', import.meta.url), 'utf8'));
  const statusColumns = (await native.pool.query(`SELECT table_schema,table_name,column_name,udt_schema,udt_name FROM information_schema.columns
    WHERE (table_schema,table_name,column_name) IN (('auth','users','approval_status'),('hr','leave_requests','status'),('accounting','settlements','status'),('org','approval_requests','status'))
    ORDER BY table_schema,table_name`)).rows;
  assert.ok(statusColumns.length >= 3);
  assert.ok(statusColumns.every(row => row.udt_schema === 'common' && row.udt_name === 'approval_status'));
  const labels = (await native.pool.query(`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='common' AND t.typname='approval_status' ORDER BY enumsortorder`)).rows.map(row => row.enumlabel);
  assert.deepEqual(labels, ['pending', 'approved', 'rejected', 'draft', 'withdrawn']);

  server = await startTestServer();
  const pg = await import('../src/config/pg.js'); closePgPool = pg.closePgPool;
  async function api(actor, route, method = 'GET', body, expected = 200) {
    const response = await fetch(server.baseUrl + '/pg' + route, { method, headers: {
      'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId ?? '' } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await response.text(), result = text ? JSON.parse(text) : null;
    scenarios.push({ method, route, actor: actor?.id ?? null, status: response.status, code: result?.error?.code });
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
    return result;
  }
  async function signup(label) {
    const email = `${label}-${randomUUID()}@example.invalid`;
    const result = await api(null, '/auth/signup', 'POST', { name: label, email, password: 'password-1234' }, 201);
    return { token: result.token, id: result.user.id, email };
  }
  const owner = await signup('approval-owner');
  const company = await api(owner, '/companies', 'POST', { name: 'APPROVAL_NATIVE', modules: ['approvals'], features: ['approvals'] }, 201);
  owner.orgId = company.org_id;
  async function member(label) {
    const result = await api(owner, '/members', 'POST', { name: label, email: `${label}-${randomUUID()}@example.invalid`, password: 'password-1234' }, 201);
    const roleId = (await native.pool.query("SELECT id FROM org.roles WHERE company_id=$1 AND name='company_creator'", [company.org_id.slice(3)])).rows[0].id;
    await native.pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES($1,$2)', [result.id, roleId]);
    const loginEmail = (await native.pool.query('SELECT email FROM auth.users WHERE id=$1', [result.id])).rows[0].email;
    const login = await api(null, '/auth/login', 'POST', { email: loginEmail, password: 'password-1234' });
    return { token: login.token, id: result.id, orgId: company.org_id };
  }
  const decider = await member('approval-decider'), bystander = await member('approval-bystander');
  const foreign = await signup('approval-foreign');
  const foreignCompany = await api(foreign, '/companies', 'POST', { name: 'APPROVAL_FOREIGN', modules: ['approvals'], features: ['approvals'] }, 201);
  foreign.orgId = foreignCompany.org_id;

  let generic = (await api(owner, '/approvals/forms')).items.find(form => form.key === 'generic');
  assert.equal(generic.builtin, true);
  generic = await api(owner, '/approvals/forms', 'POST', { key: 'generic', name: '일반 요청', fields: [{ key: 'purpose', type: 'text', required: true }] }, 201);
  const draft = await api(owner, '/approvals/drafts', 'POST', { form_key: 'generic', title: 'PG 출장 품의', body: { purpose: '고객 미팅' } }, 201);
  await api(bystander, `/approvals/${draft.id}`, 'GET', undefined, 404);
  await api(foreign, `/approvals/${draft.id}`, 'GET', undefined, 404);
  assert.equal((await api(bystander, '/approvals')).items.some(item => String(item.__id) === draft.id), false);
  await api(owner, `/approvals/${draft.id}/draft`, 'PATCH', { expected_version: 999, title: 'stale' }, 409);
  const revised = await api(owner, '/approvals/forms', 'POST', { key: 'generic', name: '일반 요청 v2', fields: [{ key: 'purpose', type: 'text', required: true }] });
  await api(owner, `/approvals/${draft.id}/submit`, 'POST', { expected_version: draft.version, form_revision: generic.revision }, 409);

  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ccddee' } }).png().toBuffer();
  async function upload(actor = owner) {
    const response = await fetch(server.baseUrl + '/pg/approvals/receipt-uploads', { method: 'POST', headers: {
      Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'image/png', 'X-Upload-Name': encodeURIComponent('PG결재.png'),
    }, body: png, signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result;
  }
  const staged = await upload();
  // Numeric request CAS and the internal xmin are distinct: alter xmin without changing request version.
  await native.pool.query('UPDATE org.approval_requests SET title=title WHERE id=$1', [draft.id]);
  const submitted = await api(owner, `/approvals/${draft.id}/submit`, 'POST', {
    expected_version: draft.version, form_revision: revised.revision, receipt_tokens: [staged.token],
  });
  assert.equal(submitted.status, 'pending');
  assert.equal(submitted.attachment_snapshot[0].checksum_sha256, hash(png));
  assert.equal(submitted.form_snapshot.revision, revised.revision);
  await assert.rejects(native.pool.query("UPDATE org.approval_requests SET title='changed pending' WHERE id=$1", [draft.id]), { code: '23514' });
  await api(owner, `/approvals/${draft.id}/draft`, 'PATCH', { expected_version: submitted.version, title: 'mutate' }, 409);
  const poolDetail = await api(bystander, `/approvals/${draft.id}`);
  assert.equal(poolDetail.id, draft.id);
  assert.ok((await api(bystander, `/approvals/${draft.id}/history`)).items.length >= 2);
  const receiptResponse = await fetch(server.baseUrl + `/pg/approvals/${draft.id}/receipts/${submitted.attachment_snapshot[0].file_id}`, {
    headers: { Authorization: `Bearer ${bystander.token}`, 'X-Org-Id': bystander.orgId }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(receiptResponse.status, 200); assert.equal(hash(Buffer.from(await receiptResponse.arrayBuffer())), hash(png));
  await api(foreign, `/approvals/${draft.id}/receipts/${submitted.attachment_snapshot[0].file_id}`, 'GET', undefined, 404);
  await api(bystander, `/approvals/${draft.id}/actions`, 'POST', { decision: 'reject', comment: '   ' }, 400);

  const rollbackDraft = await api(owner, '/approvals/drafts', 'POST', { title: '원자 rollback', body: { purpose: '검증' } }, 201);
  const rollbackUpload = await upload();
  await native.pool.query(`CREATE FUNCTION org.test_approval_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'approval audit injected'; END $$;
    CREATE TRIGGER test_approval_audit_failure BEFORE INSERT ON org.role_change_events FOR EACH ROW
    WHEN (NEW.action='approval.submitted') EXECUTE FUNCTION org.test_approval_audit_failure()`);
  try {
    await api(owner, `/approvals/${rollbackDraft.id}/submit`, 'POST', { expected_version: rollbackDraft.version, form_revision: revised.revision, receipt_tokens: [rollbackUpload.token] }, 500);
  } finally {
    await native.pool.query('DROP TRIGGER test_approval_audit_failure ON org.role_change_events; DROP FUNCTION org.test_approval_audit_failure()');
  }
  assert.equal((await native.pool.query('SELECT status FROM org.approval_requests WHERE id=$1', [rollbackDraft.id])).rows[0].status, 'draft');
  assert.equal((await native.pool.query('SELECT state FROM files.receipt_uploads WHERE token_hash=$1', [hash(rollbackUpload.token)])).rows[0].state, 'ready');
  assert.equal((await native.pool.query('SELECT count(*)::int AS n FROM org.approval_request_files WHERE approval_id=$1', [rollbackDraft.id])).rows[0].n, 0);

  const raceDraft = await api(owner, '/approvals/drafts', 'POST', { title: '결정 철회 race', body: { purpose: '경합' } }, 201);
  const racePending = await api(owner, `/approvals/${raceDraft.id}/submit`, 'POST', { expected_version: raceDraft.version, form_revision: revised.revision });
  const race = await Promise.all([
    api(decider, `/approvals/${raceDraft.id}/actions`, 'POST', { decision: 'approve' }, 200).catch(error => error),
    api(owner, `/approvals/${raceDraft.id}/withdraw`, 'POST', { expected_version: racePending.version }, 200).catch(error => error),
  ]);
  const recorded = scenarios.filter(item => item.route.includes(`/approvals/${raceDraft.id}/`) && ['actions', 'withdraw'].some(suffix => item.route.endsWith(suffix)));
  assert.deepEqual(recorded.map(item => item.status).sort(), [200, 409]);
  assert.ok(race.every(item => !(item instanceof Error) || /409/.test(item.message)));
  const raceFinal = await api(owner, `/approvals/${raceDraft.id}`);
  assert.ok(['approved', 'withdrawn'].includes(raceFinal.status));

  const selfDraft = await api(owner, '/approvals/drafts', 'POST', { title: '본인 결정', body: { purpose: '정책 보존' } }, 201);
  const selfPending = await api(owner, `/approvals/${selfDraft.id}/submit`, 'POST', { expected_version: selfDraft.version, form_revision: revised.revision });
  await api(owner, `/approvals/${selfDraft.id}/actions`, 'POST', { decision: 'reject', comment: '본인 반려' }, 400);
  const rejected = await api(owner, `/approvals/${selfDraft.id}/actions`, 'POST', { decision: 'reject', comment: '본인 반려', confirm_self_decision: true });
  assert.equal(rejected.status, 'rejected');
  const linked = await api(owner, `/approvals/${selfDraft.id}/resubmit`, 'POST', { expected_version: rejected.version }, 201);
  assert.equal(linked.predecessor_id, selfDraft.id); assert.equal(linked.status, 'draft'); assert.deepEqual(linked.attachment_snapshot, []);
  assert.equal((await native.pool.query(`SELECT (after_data->>'self_decision')::boolean AS self_decision FROM org.role_change_events
    WHERE company_id=$1 AND resource_id=$2 AND action='approval.decided' ORDER BY id DESC LIMIT 1`, [company.org_id.slice(3), selfDraft.id])).rows[0].self_decision, true);

  const immediate = await api(owner, '/approvals', 'POST', { request_type: '기존 PG 즉시 제출', note: '호환 경로' }, 201);
  const immediateDecision = await api(owner, `/approvals/${immediate.id}/decide`, 'POST', { decision: 'approve' });
  assert.equal(immediateDecision.status, 'approved');
  assert.equal((await native.pool.query('SELECT workflow_locked FROM org.approval_requests WHERE id=$1', [immediate.id])).rows[0].workflow_locked, false);

  await assert.rejects(native.pool.query("UPDATE org.approval_requests SET title='changed' WHERE id=$1", [selfDraft.id]), { code: '23514' });
  await assert.rejects(native.pool.query('DELETE FROM org.approval_request_history WHERE approval_id=$1', [selfDraft.id]), { code: '23514' });
  scenarios.push({ native: 'PostgreSQL 18 actual HTTP', enumCommitSeparated: true, formCAS: true, requestVersionSeparateFromXmin: true,
    snapshotImmutable: true, rollbackAtomic: true, raceFinal: raceFinal.status, selfDecisionConfirmed: true });
  passed = true;
  console.log(JSON.stringify({ passed, scenarios }, null, 2));
} finally {
  if (server) { await server.close(); cleanup.serverClosed = true; }
  await closePgPool?.(); await native.close(); cleanup.nativeClosed = true;
  if (cleanup.native) cleanup.native.directoryRemoved = !existsSync(cleanup.native.directory);
  await writeFile(new URL('native-http.json', evidence), JSON.stringify({ passed, scenarios }, null, 2));
  await writeFile(new URL('cleanup.json', evidence), JSON.stringify(cleanup, null, 2));
}
