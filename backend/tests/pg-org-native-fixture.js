import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { hashPassword } from '../src/utils/crypto.js';

// 실제 네이티브 PostgreSQL 전용. 기존/원격 DB 접속정보는 사용하지 않는다.
export async function startOrgPostgres({ audit = true } = {}) {
  const bin = process.env.ORG_TEST_PG_BIN;
  if (!bin) throw new Error('ORG_TEST_PG_BIN must identify isolated native PostgreSQL binaries');
  const root = await mkdtemp(path.join(tmpdir(), 'perp-org-native-'));
  const data = path.join(root, 'data');
  function run(command, args) {
    const log = path.join(root, `${command}.log`), fd = openSync(log, 'w');
    let result;
    try { result = spawnSync(path.join(bin, command + (process.platform === 'win32' ? '.exe' : '')), args, { stdio: ['ignore', fd, fd], timeout: 60000 }); }
    finally { closeSync(fd); }
    if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error ?? result.status}\n${readFileSync(log, 'utf8')}`);
  }
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let started = false, pool;
  const close = async () => {
    await pool?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  };
  try {
    run('initdb', ['-D', data, '-U', 'org_test', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    started = true;
    process.env.DATABASE_URL = '';
    process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = String(port);
    process.env.PG_DATABASE = 'postgres'; process.env.PG_USER = 'org_test'; process.env.PG_PASSWORD = '';
    pool = new pg.Pool({ host: '127.0.0.1', port, database: 'postgres', user: 'org_test' });
    for (const file of ['perp_schema.sql', ...[2, 3, 4, 5, 6, 7].map(v => `perp_additions_v${v}.sql`), ...(audit ? ['perp_additions_v10_org_audit.sql'] : [])]) {
      await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    }
    const company = (await pool.query("INSERT INTO org.companies(name) VALUES ('F8_ISOLATED_A'), ('F8_ISOLATED_B') RETURNING id")).rows;
    const companyId = company[0].id, otherCompanyId = company[1].id;
    const users = [];
    for (let i = 0; i < 4; i++) {
      users.push((await pool.query(`INSERT INTO auth.users(company_id,email,name,password_hash,approval_status)
        VALUES ($1,$2,$3,$4,'approved') RETURNING id,email,name`, [i === 3 ? otherCompanyId : companyId, `f8-${i}@example.invalid`, `F8 검증 ${i}`, hashPassword('password-1234')])).rows[0]);
    }
    for (let i = 0; i < users.length; i++) await pool.query('INSERT INTO org.company_memberships(company_id,user_id) VALUES ($1,$2)', [i === 3 ? otherCompanyId : companyId, users[i].id]);
    const depts = (await pool.query("INSERT INTO org.departments(company_id,name) VALUES ($1,'F8 개발'),($1,'F8 운영'),($2,'F8 외부') RETURNING id,name", [companyId, otherCompanyId])).rows;
    const codes = ['member.read', 'department.write', 'audit.read', 'menu.members', 'menu.home', 'menu.configured'];
    await pool.query("INSERT INTO org.permissions(code,module,description) SELECT code,'members',code FROM unnest($1::text[]) code ON CONFLICT (code) DO NOTHING", [codes]);
    for (const [cid, uid] of [[companyId, users[0].id], [otherCompanyId, users[3].id]]) {
      const role = (await pool.query("INSERT INTO org.roles(company_id,name) VALUES ($1,'F8_EXISTING_ROLE') RETURNING id", [cid])).rows[0];
      await pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [role.id, codes]);
      await pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES ($1,$2)', [uid, role.id]);
    }
    await pool.query("INSERT INTO org.positions(company_id,name,rank_level) VALUES ($1,'선임',3)", [companyId]);
    console.log(JSON.stringify({ engine: (await pool.query('SELECT version()')).rows[0].version, host: '127.0.0.1', port, data: root, fixture: 'isolated actual PostgreSQL, not SQL mock' }));
    return { pool, companyId, otherCompanyId, users, depts, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PostgreSQL setup and cleanup failed'); }
    throw error;
  }
}
