import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { hashPassword } from '../src/utils/crypto.js';

// 실제 네이티브 PostgreSQL. 외부 접속설정을 사용하지 않고 매 실행마다 새 로컬 클러스터를 만든다.
export async function startDailyNativePostgres() {
  const bin = process.env.DAILY_TEST_PG_BIN;
  if (!bin) throw new Error('DAILY_TEST_PG_BIN must identify local PostgreSQL binaries');
  const root = await mkdtemp(path.join(tmpdir(), 'perp-daily-native-')), data = path.join(root, 'data');
  const run = (command, args) => {
    const log = path.join(root, command + '.log'), fd = openSync(log, 'w');
    let result;
    try { result = spawnSync(path.join(bin, command + (process.platform === 'win32' ? '.exe' : '')), args, { stdio: ['ignore', fd, fd], timeout: 60000 }); }
    finally { closeSync(fd); }
    if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error ?? result.status}\n${readFileSync(log, 'utf8')}`);
  };
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  let started = false, pool;
  const close = async () => {
    await pool?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  };
  try {
    run('initdb', ['-D', data, '-U', 'daily_test', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']); started = true;
    process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = String(port);
    process.env.PG_DATABASE = 'postgres'; process.env.PG_USER = 'daily_test'; process.env.PG_PASSWORD = '';
    pool = new pg.Pool({ host: '127.0.0.1', port, database: 'postgres', user: 'daily_test' });
    for (const file of ['perp_schema.sql', ...[2,3,4,5,6,7].map(v => `perp_additions_v${v}.sql`), 'perp_additions_v8_daily_finance.sql', 'perp_additions_v9_daily_corrections.sql', 'perp_additions_v9_daily_corrections.sql', 'perp_additions_v10_org_audit.sql']) {
      await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    }
    const companies = (await pool.query("INSERT INTO org.companies(name) VALUES ('DAILY_ISOLATED_A'),('DAILY_ISOLATED_B') RETURNING id")).rows;
    const companyId = companies[0].id, otherCompanyId = companies[1].id, users = [];
    for (let i = 0; i < 3; i++) users.push((await pool.query(`INSERT INTO auth.users(company_id,email,name,password_hash,approval_status)
      VALUES ($1,$2,$3,$4,'approved') RETURNING id,email,name`, [i === 0 ? companyId : otherCompanyId, `daily-${i}@example.invalid`, `일상 검증 ${i}`, hashPassword('password-1234')])).rows[0]);
    // 담당자의 global company는 B여도 실제 활성 membership A가 있으면 이관 가능해야 한다.
    for (const [cid, uid] of [[companyId,users[0].id],[companyId,users[1].id],[otherCompanyId,users[1].id],[otherCompanyId,users[2].id]]) await pool.query('INSERT INTO org.company_memberships(company_id,user_id) VALUES ($1,$2)', [cid,uid]);
    const codes = ['member.read','project.read','project.write','task.read','task.write','event.read','event.write','asset.read','asset.write','notification.read','menu.notifications','menu.home','menu.projects','menu.tasks','menu.calendar','menu.assets','menu.members','menu.configured'];
    await pool.query("INSERT INTO org.permissions(code,module,description) SELECT code,'daily',code FROM unnest($1::text[]) code ON CONFLICT (code) DO NOTHING", [codes]);
    const role = (await pool.query("INSERT INTO org.roles(company_id,name) VALUES ($1,'DAILY_TEST_ROLE') RETURNING id", [companyId])).rows[0];
    await pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [role.id,codes]);
    await pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES ($1,$2)', [users[0].id,role.id]);
    const recipientRole = (await pool.query("INSERT INTO org.roles(company_id,name) VALUES ($1,'DAILY_RECIPIENT_ROLE') RETURNING id", [companyId])).rows[0];
    await pool.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code=ANY($2::text[])', [recipientRole.id,['notification.read','task.read','project.read','member.read','menu.notifications','menu.tasks','menu.projects','menu.members','menu.home','menu.configured']]);
    await pool.query('INSERT INTO org.user_roles(user_id,role_id) VALUES ($1,$2)', [users[1].id,recipientRole.id]);
    await pool.query("INSERT INTO org.company_modules(company_id,module_key) SELECT $1,k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING", [companyId,['projects','tasks','calendar','assets']]);
    console.log(JSON.stringify({ engine: (await pool.query('SELECT version()')).rows[0].version, host: '127.0.0.1', port, temporaryCluster: root, fixture: 'isolated native PostgreSQL, real auth/memberships/SQL', migrationAppliedTwice: true, integratedMigrations: [8,9,10] }));
    return { pool, companyId, otherCompanyId, assigneeId: users[1].id, foreignId: users[2].id, identity: { users }, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native setup and cleanup failed'); }
    throw error;
  }
}
