const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtemp, rm, readFile, writeFile, mkdir } = require('node:fs/promises');
const { openSync, closeSync, readFileSync, existsSync } = require('node:fs');
const { once } = require('node:events');
const { createServer } = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client, Pool } = require('pg');
const root = path.resolve(__dirname, '../../../../..');
const evidence = path.join(root, '.omo/evidence/task-13-deadline-erp-redesign');

async function fixture() {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const bin = process.env.ORG_TEST_PG_BIN;
  assert.ok(bin, 'explicit --pg-bin required');
  const temporary = await mkdtemp(path.join(process.env.DEADLINE_TEMP_ROOT, 't13-native-'));
  const data = path.join(temporary, 'data');
  const report = { runId: process.env.DEADLINE_RUN_ID, pid: process.pid, temporary, ports: [], http: [], mails: [], native: null };
  let started = false, erp, server, db, mailDb, prisma, mail, oldInvite, oldCancel;
  const mailChecks = [];
  function run(name, args) {
    const log = path.join(temporary, `${name}.log`), fd = openSync(log, 'w');
    let result;
    try { result = spawnSync(path.join(bin, `${name}.exe`), args, { stdio: ['ignore', fd, fd], timeout: 60000 }); }
    finally { closeSync(fd); }
    if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error ?? result.status}\n${readFileSync(log, 'utf8')}`);
  }
  async function close() {
    const failures = [];
    for (const action of [
      async () => { if (server?.listening) { const done = once(server, 'close', { signal: AbortSignal.timeout(10000) }); server.close(); server.closeAllConnections(); await done; } },
      async () => { await Promise.all(mailChecks); },
      async () => { await prisma?.$disconnect(); await db?.end(); await mailDb?.end(); },
      async () => { await erp?.close(); },
      async () => { if (started) { run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); started = false; } },
      async () => { if (!started) await rm(temporary, { recursive: true, force: true }); },
    ]) { try { await action(); } catch (e) { failures.push(e); } }
    if (mail) { mail.sendAttendeeInvite = oldInvite; mail.sendReservationCancelled = oldCancel; }
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, `scenario-${report.runId}.json`), JSON.stringify(report, null, 2));
    await writeFile(path.join(evidence, `cleanup-${report.runId}.json`), JSON.stringify({ runId: report.runId, postgresPid: report.postgresPid, ports: report.ports, serverClosed: !server?.listening, postgresStopped: !started, temporaryRemoved: !existsSync(temporary), erp: erp?.resource, errors: failures.map(e => e.message) }, null, 2));
    if (failures.length) throw new AggregateError(failures, 'T13 cleanup');
  }
  try {
    const helpers = await import(pathToFileURL(path.join(root, 'backend/tests/deadline-fixture.js')).href);
    erp = await helpers.startDeadlineServer();
    async function company(name) {
      const signed = await erp.request(null, '/auth/signup', 'POST', { name, email: `${name}@example.invalid`, password: 't13-password-1234' }, 201);
      const actor = { token: signed.access_token, userId: signed.user.id };
      const org = await erp.request(actor, '/tenants', 'POST', { name, type: 'custom', modules: ['assets'], features: [], departments: [] }, 201);
      actor.orgId = org.org_id;
      actor.principal = await erp.request(actor, '/auth/reservation-principal');
      return actor;
    }
    const A = await company('t13-a'), B = await company('t13-b');
    const invite = await erp.request(A, '/members/invites', 'POST', { email: 't13-member@example.invalid', roles: ['member'] }, 201);
    const signed = await erp.request(null, '/auth/signup', 'POST', { name: 'member', email: 't13-member@example.invalid', password: 't13-password-1234', invitation_token: invite.token }, 201);
    const member = { token: signed.access_token, userId: signed.user.id, orgId: A.orgId };
    member.principal = await erp.request(member, '/auth/reservation-principal');
    const portLease = net.createServer();
    const ready = once(portLease, 'listening', { signal: AbortSignal.timeout(10000) }); portLease.listen(0, '127.0.0.1'); await ready;
    const port = portLease.address().port;
    await new Promise((resolve, reject) => portLease.close(e => e ? reject(e) : resolve()));
    assert.ok(![8000, 5174, 8080, 55432].includes(port));
    run('initdb', ['-D', data, '-U', 't13_fixture', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    run('pg_ctl', ['-D', data, '-l', path.join(temporary, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']); started = true;
    report.postgresPid = Number((await readFile(path.join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    report.ports.push(port, erp.resource.port);
    const url = `postgresql://t13_fixture@127.0.0.1:${port}/postgres?connection_limit=4`;
    db = new Client({ connectionString: url }); await db.connect();
    mailDb = new Pool({ connectionString: url, max: 4 });
    report.native = (await db.query('select version()')).rows[0].version;
    assert.match(report.native, /PostgreSQL 18\.6/);
    for (const folder of ['20260907000000_reservation_baseline', '20260907010000_add_organization_scope']) {
      await db.query(await readFile(path.join(root, 'Reservation/backend/prisma/migrations', folder, 'migration.sql'), 'utf8'));
    }
    process.env.DATABASE_URL = url;
    process.env.ERP_API_URL = erp.baseUrl;
    process.env.MAIL_HOST = '127.0.0.1'; process.env.MAIL_PORT = '1';
    prisma = require('../../lib/prisma').prisma;
    mail = require('../../notification/email.service').emailService;
    oldInvite = mail.sendAttendeeInvite; oldCancel = mail.sendReservationCancelled;
    mail.sendAttendeeInvite = attendee => {
      const check = mailDb.query('SELECT id FROM attendees WHERE id=$1', [attendee.id]).then(result => {
        assert.equal(result.rowCount, 1, 'email must follow commit visible on independent connection');
        report.mails.push({ attendeeId: attendee.id, committed: true });
      });
      mailChecks.push(check); return check;
    };
    mail.sendReservationCancelled = async () => {};
    server = createServer(require('../../app').default);
    const listening = once(server, 'listening', { signal: AbortSignal.timeout(10000) }); server.listen(0, '127.0.0.1'); await listening;
    const apiPort = server.address().port; report.ports.push(apiPort);
    const base = `http://127.0.0.1:${apiPort}/api/v1`;
    async function request(actor, route, method = 'GET', body) {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      await Promise.all(mailChecks);
      report.http.push({ route, method, status: response.status, body: helpers.evidenceBody(result) });
      return { status: response.status, body: result };
    }
    const seeded = await request(A, '/spaces/test-spaces', 'POST', {}); assert.equal(seeded.status, 200);
    return { A, B, member, db, prisma, erp, request, close, report, mailChecks, spaceId: seeded.body.data.spaces[0].id };
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup]); } throw error; }
}
module.exports = { fixture };
