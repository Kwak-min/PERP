import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';
import { protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';

export async function nativeRoleFixture(api) {
  const bin = process.env.ORG_TEST_PG_BIN; assert.ok(bin, 'isolated --pg-bin PG18 required');
  const root = await mkdtemp(path.join(process.env.DEADLINE_TEMP_ROOT, 'role-ui-pg-')), data = path.join(root, 'data');
  const resource = { root, port: null, pid: null, stopped: false, temporaryRemoved: false };
  let pool, started = false;
  function command(name, args) {
    const log = path.join(root, name + '.log'), fd = openSync(log, 'w');
    let child;
    try { child = spawnSync(path.join(bin, name + '.exe'), args, { stdio: ['ignore', fd, fd], timeout: 60000 }); }
    finally { closeSync(fd); }
    assert.equal(child.status, 0, `${name}: ${child.error ?? readFileSync(log, 'utf8')}`);
  }
  async function close() {
    await pool?.end();
    if (started) { command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); started = false; resource.stopped = true; }
    await rm(root, { recursive: true, force: true }); resource.temporaryRemoved = !existsSync(root);
  }
  try {
    const reservation = net.createServer();
    const listening = once(reservation, 'listening', { signal: AbortSignal.timeout(5000) });
    reservation.listen(0, '127.0.0.1'); await listening; resource.port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    assert.ok(!protectedPorts.has(resource.port));
    command('initdb', ['-D', data, '-U', 'deadline_role_ui', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    command('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${resource.port}`, '-w', 'start']); started = true;
    resource.pid = Number((await readFile(path.join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    const config = { host: '127.0.0.1', port: resource.port, database: 'postgres', user: 'deadline_role_ui', password: '', connectionTimeoutMillis: 5000 };
    pool = new pg.Pool(config);
    const { pgPool } = await import('../../backend/src/config/pg.js'); Object.assign(pgPool.options, config);
    for (const file of ['perp_schema.sql', ...[2, 3, 4, 5, 6, 7].map(version => `perp_additions_v${version}.sql`), 'perp_additions_v10_org_audit.sql', 'perp_additions_v11_deadline_roles.sql']) await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    const engine = (await pool.query('SELECT version()')).rows[0].version; assert.match(engine, /PostgreSQL 18\./);
    async function company(name) {
      const user = await api.request(null, '/pg/auth/signup', 'POST', { email: `${name}@example.invalid`, name, password: 'password-1234' }, 201);
      const actor = { token: user.token, userId: String(user.user.id), name, email: user.user.email };
      const created = await api.request(actor, '/pg/companies', 'POST', { name, modules: ['projects', 'tasks', 'hr', 'imports'], features: [], departments: [] }, 201);
      actor.orgId = created.org_id; return { actor, id: created.org_id };
    }
    const A = await company('UI_PG_A'), B = await company('UI_PG_B');
    const actors = [];
    for (const name of ['UI_BACKUP', 'UI_MEMBER']) {
      const created = await api.request(A.actor, '/pg/members', 'POST', { email: `${name}@example.invalid`, name, password: 'password-1234' }, 201);
      const login = await api.request(null, '/pg/auth/login', 'POST', { email: `${name}@example.invalid`, password: 'password-1234' });
      actors.push({ token: login.token, userId: String(created.id), orgId: A.id, name, email: `${name}@example.invalid` });
    }
    for (const actor of [A.actor, B.actor, ...actors]) {
      const memberships = await api.request(actor, '/pg/auth/workspace');
      actor.session = { token: actor.token, orgId: actor.orgId, name: actor.name, email: actor.email, organizations: memberships.organizations, mustChangePassword: false };
    }
    return { fixture: { A, B, actorAdmin: A.actor, actorManager: actors[0], actorMember: actors[1] }, resource, engine, close };
  } catch (error) { await close(); throw error; }
}
