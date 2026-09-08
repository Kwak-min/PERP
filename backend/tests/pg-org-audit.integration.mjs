import assert from 'node:assert/strict';
import { startOrgPostgres } from './pg-org-native-fixture.js';
import { api, startTestServer } from './http.js';

const red = process.env.ORG_TEST_RED === '1';
let database, server;
try {
  database = await startOrgPostgres({ audit: !red });
  server = await startTestServer();
  const { pool, users, depts, companyId, otherCompanyId } = database;
  const login = async user => {
    const r = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: user.email, password: 'password-1234' } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.token;
  };
  const owner = { token: await login(users[0]), orgId: `pg:${companyId}` };
  const other = { token: await login(users[3]), orgId: `pg:${otherCompanyId}` };
  const call = (route, body, session = owner) => api(server.baseUrl, `/pg/members${route}`, { ...session, ...(body ? { method: 'PATCH', body } : {}) });
  const snapshot = async () => ({
    departments: (await pool.query('SELECT id,manager_id,name FROM org.departments ORDER BY id')).rows,
    memberships: (await pool.query('SELECT company_id,user_id,department_id,position_id FROM org.company_memberships ORDER BY company_id,user_id')).rows,
    ...(red ? {} : { revisions: (await pool.query('SELECT id,org_revision FROM org.companies ORDER BY id')).rows,
      events: (await pool.query('SELECT * FROM org.organization_change_events ORDER BY id')).rows }),
  });
  if (red) {
    const statuses = [];
    statuses.push((await call(`/departments/${depts[0].id}`, { leader_id: users[0].id })).status);
    statuses.push((await call(`/${users[1].id}/assignment`, { department_id: depts[0].id })).status);
    statuses.push((await call(`/${users[3].id}/assignment`, { department_id: depts[0].id })).status);
    const activity = await call('/activity');
    assert.deepEqual(statuses, [200, 200, 404]); assert.equal(activity.status, 501);
    const state = await snapshot();
    assert.equal(state.departments[0].manager_id, users[0].id);
    assert.equal(state.memberships[1].department_id, depts[0].id);
    console.log(JSON.stringify({ RED_PARTIAL_APPLICATION: statuses, RED_ACTIVITY: activity.status, persisted: state }));
    const atomic = await call(`/departments/${depts[0].id}/seat`, { expected_revision: '1', leader_id: users[0].id, assigned: [users[1].id, users[2].id] });
    assert.equal(atomic.status, 200, 'RED: missing atomic seat endpoint');
  } else {
    const chart = await call('/org-chart'); assert.equal(chart.status, 200);
    const revision = chart.body.revision;
    assert.match(revision, /^[1-9]\d*$/);
    const body = { expected_revision: revision, leader_id: users[0].id, assigned: [users[1].id, users[2].id] };
    const initial = await snapshot();
    // 같은 회사 범위를 벗어난 부서/책임자/구성원은 쓰기 전에 거절한다.
    for (const [id, input] of [[depts[2].id, body], [depts[0].id, { ...body, leader_id: users[3].id }], [depts[0].id, { ...body, assigned: [users[1].id, users[3].id] }]]) {
      const r = await call(`/departments/${id}/seat`, input); assert.ok([400, 404].includes(r.status), JSON.stringify(r));
      assert.deepEqual(await snapshot(), initial);
    }
    // 실제 PG 트리거가 두 번째 배정/감사 쓰기를 실패시켜 앞선 쓰기까지 롤백시킨다.
    await pool.query(`CREATE FUNCTION org.f8_fail_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id = ${users[2].id} THEN RAISE EXCEPTION 'F8 injected second assignment failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER f8_fail_assignment BEFORE UPDATE ON org.company_memberships FOR EACH ROW EXECUTE FUNCTION org.f8_fail_assignment()`);
    assert.equal((await call(`/departments/${depts[0].id}/seat`, body)).status, 500);
    assert.deepEqual(await snapshot(), initial);
    await pool.query('DROP TRIGGER f8_fail_assignment ON org.company_memberships; DROP FUNCTION org.f8_fail_assignment()');
    await pool.query(`CREATE FUNCTION org.f8_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'F8 injected audit failure'; END $$;
      CREATE TRIGGER f8_fail_audit BEFORE INSERT ON org.organization_change_events FOR EACH ROW EXECUTE FUNCTION org.f8_fail_audit()`);
    assert.equal((await call(`/departments/${depts[0].id}/seat`, body)).status, 500);
    assert.deepEqual(await snapshot(), initial);
    await pool.query('DROP TRIGGER f8_fail_audit ON org.organization_change_events; DROP FUNCTION org.f8_fail_audit()');
    const saved = await call(`/departments/${depts[0].id}/seat`, body);
    assert.equal(saved.status, 200, JSON.stringify(saved)); assert.notEqual(saved.body.revision, revision);
    const committed = await snapshot();
    assert.equal(committed.departments[0].manager_id, users[0].id);
    assert.deepEqual(committed.memberships.slice(1, 3).map(m => m.department_id), [depts[0].id, depts[0].id]);
    assert.equal(committed.events.length, 3);
    assert.ok(committed.events.every(e => e.actor_id === users[0].id && e.company_id === companyId && e.target && e.before_data && e.after_data && e.request_id && e.created_at instanceof Date));
    const activity = await call('/activity?limit=200'); assert.equal(activity.status, 200);
    assert.equal(activity.body.items.length, 3);
    assert.ok(activity.body.items.every(e => e.actor_id === users[0].id && e.actor_name === users[0].name && Number.isFinite(Date.parse(e.created_at))));
    assert.deepEqual((await call('/activity', undefined, other)).body.items, []);
    assert.equal((await call('/activity', undefined, { ...other, orgId: owner.orgId })).status, 403);
    assert.equal((await call(`/departments/${depts[0].id}/seat`, body)).status, 409);
    assert.deepEqual(await snapshot(), committed);
    const filtered = await call(`/activity?member_id=${users[1].id}`);
    assert.equal(filtered.body.items.length, 1); assert.equal(filtered.body.items[0].resource_id, users[1].id);
    assert.equal((await call('/activity?limit=invalid')).status, 400);
    const unknownTitle = await call(`/${users[1].id}/assignment`, { department_id: depts[1].id, title: 'not-a-company-position' });
    assert.equal(unknownTitle.status, 400); assert.deepEqual(await snapshot(), committed);
    assert.equal((await call(`/${users[1].id}/assignment`, { title: '선임' })).status, 200);
    const titleEvent = (await call(`/activity?member_id=${users[1].id}`)).body.items[0];
    assert.equal(titleEvent.after.title, '선임'); assert.equal(titleEvent.before.title, null);
    // 두 실제 HTTP 요청은 같은 revision에서 경합한다. 실행 순서에 관계없이 하나만 커밋된다.
    const competingRevision = (await call('/org-chart')).body.revision;
    const competing = await Promise.all([users[1], users[2]].map(user => call(`/departments/${depts[0].id}/seat`, {
      expected_revision: competingRevision, leader_id: user.id, assigned: [user.id],
    })));
    assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
    const afterRace = await snapshot();
    assert.equal(afterRace.events.length, 6);
    const winner = competing[0].status === 200 ? users[1] : users[2];
    assert.equal(afterRace.departments[0].manager_id, winner.id);
    assert.deepEqual(afterRace.memberships.filter(m => m.department_id === depts[0].id).map(m => m.user_id), [winner.id]);
    // 단건 생성/수정도 감사 저장 실패 시 배정 경로와 동일하게 롤백한다.
    const created = await api(server.baseUrl, '/pg/members/departments', { ...owner, method: 'POST', body: { name: 'F8 명시적 하위 부서', parent_id: depts[0].id } });
    assert.equal(created.status, 201);
    const creation = (await call('/activity')).body.items[0];
    assert.equal(creation.action, 'department.created'); assert.equal(creation.before, null); assert.equal(creation.after.parent_id, depts[0].id);
    await pool.query(`CREATE FUNCTION org.f8_fail_single_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'F8 injected single audit failure'; END $$;
      CREATE TRIGGER f8_fail_single_audit BEFORE INSERT ON org.organization_change_events FOR EACH ROW EXECUTE FUNCTION org.f8_fail_single_audit()`);
    const beforeSingleFailures = await snapshot();
    assert.equal((await call(`/departments/${depts[0].id}`, { name: 'F8 rollback rename' })).status, 500);
    assert.deepEqual(await snapshot(), beforeSingleFailures);
    assert.equal((await call(`/${winner.id}/assignment`, { department_id: depts[1].id })).status, 500);
    assert.deepEqual(await snapshot(), beforeSingleFailures);
    await pool.query('DROP TRIGGER f8_fail_single_audit ON org.organization_change_events; DROP FUNCTION org.f8_fail_single_audit()');
    const roles = (await pool.query('SELECT r.name FROM org.roles r JOIN org.user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1', [users[0].id])).rows;
    assert.deepEqual(roles.map(r => r.name), ['F8_EXISTING_ROLE']);
    console.log(JSON.stringify({ GREEN_NATIVE_HTTP: true, managerAndAssignments: 3, atomicEvents: committed.events.length, statuses: { stale: 409, crossCompanyRead: 403, assignmentFailure: 500, auditFailure: 500, concurrent: competing.map(r => r.status).sort() }, rolesPreserved: roles }));
  }
} finally {
  if (server) { await (await import('../src/config/pg.js')).closePgPool(); await server.close(); }
  await database?.close();
  console.log('F8_NATIVE_OWNED_SERVICES_AND_DATA_CLEANED');
}
