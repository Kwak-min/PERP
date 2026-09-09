import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { Worker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { readImportCleanupConfig, runImportCleanupStore } from '../src/services/expense-import-maintenance.js';

// 별도 관찰 port만 추가한다. 실제 제품 worker/접속 문자열/Client/트랜잭션을 대체하지 않는다.
test('cleanup worker PG limits override URL options/direct timeouts without losing legitimate session/TLS settings', { timeout: 60000 }, async t => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const native = await startDailyNativePostgres();
  try {
    await native.pool.query(await readFile(new URL('../../db/perp_additions_v16_deadline_expense_imports.sql', import.meta.url), 'utf8'));
    for (const scenario of ['options','direct','both','tls']) await t.test(scenario, { timeout: 20000 }, async () => {
      const uploadId = randomUUID();
      await native.pool.query('INSERT INTO accounting.expense_import_uploads(id,company_id,actor_id,raw,raw_sha256,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [uploadId,native.companyId,native.identity.users[0].id,Buffer.from('fixture'),'a'.repeat(64),new Date('2000-01-01')]);
      const url = new URL(`postgres://daily_test@127.0.0.1:${process.env.PG_PORT}/postgres`);
      url.searchParams.set('port',''); // reviewer probe: empty query port still uses the explicit authority port
      url.searchParams.set('sslmode',scenario === 'tls' ? 'verify-full' : 'disable');
      url.searchParams.set('sslnegotiation','postgres');
      url.searchParams.set('application_name','cleanup-url-fixture');
      url.searchParams.set('options', '-c TimeZone=Asia/Seoul' + (scenario !== 'direct' ? ' -c statement_timeout=0 -c lock_timeout=0' : ''));
      if (scenario !== 'options') {
        url.searchParams.set('statement_timeout','0'); url.searchParams.set('lock_timeout','0');
        url.searchParams.set('connectionTimeoutMillis','0'); url.searchParams.set('connect_timeout','0');
      }
      const config = readImportCleanupConfig({ ...process.env, DATABASE_URL: url.href, ORBITFLOW_IMPORT_CLEANUP_STORES: 'perp_db', ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS: '12000' });
      const events = new EventEmitter(), channel = new MessageChannel(), abort = new AbortController();
      channel.port1.on('message', message => events.emit(message.type,message));
      const observationSignal = AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]);
      const connecting = once(events,'connecting',{signal:observationSignal});
      const limits = scenario === 'tls' ? null : once(events,'limits',{signal:observationSignal});
      const blocked = scenario === 'both';
      const queued = blocked ? once(events,'lock_queued',{signal:observationSignal}) : null;
      const lockError = blocked ? once(events,'lock_error',{signal:observationSignal}) : null;
      const observationsSettled = Promise.allSettled([connecting,limits,queued,lockError].filter(Boolean));
      let claimant, running, workerExited = false, parentDeadlineFired = false;
      try {
        if (blocked) {
          claimant = await native.pool.connect(); await claimant.query('BEGIN');
          await claimant.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE',[native.companyId]);
        }
        running = runImportCleanupStore('perp_db',config,abort.signal, {
          timers: { setTimeout(fn,ms) { return setTimeout(() => { parentDeadlineFired = true; fn(); },ms); }, clearTimeout },
          createWorker(workerUrl, options) {
            const worker = new Worker(workerUrl, { ...options,
              execArgv: ['--require',fileURLToPath(new URL('./fixtures/cleanup-pg-limits-observer.cjs',import.meta.url))],
              workerData: { ...options.workerData, limitsPort: channel.port2 }, transferList: [channel.port2] });
            worker.once('exit',() => { workerExited = true; }); return worker;
          },
        });
        const [connection] = await connecting;
        assert.equal(connection.sslEnabled,scenario === 'tls'); assert.equal(connection.sslNegotiation,'postgres');
        assert.equal(connection.poolConnectMs,5000); assert.equal(connection.clientConnectMs,5000); assert.equal(connection.connectSeconds,5);
        if (scenario === 'tls') {
          // SSL 없는 격리 서버에 verify-full 요청은 실패해야 한다. TLS query를 삭제하고 평문 성공하면 안 된다.
          assert.deepEqual(await running,{status:'failed',reason:'cleanup_error'});
          assert.equal(parentDeadlineFired,false); assert.equal(workerExited,true);
          assert.equal(config.connectionEnv.DATABASE_URL,url.href);
          console.log(JSON.stringify({scenario,...connection,tlsNotDowngraded:true,parentDeadlineFired,workerExited}));
          return;
        }
        const [observed] = await limits;
        assert.equal(observed.statement,'12s','actual native SHOW statement_timeout must reflect worker policy');
        assert.equal(observed.lock,'5s','actual native SHOW lock_timeout must reflect worker policy');
        assert.equal(observed.poolConnectMs,5000); assert.equal(observed.clientConnectMs,5000); assert.equal(observed.connectSeconds,5);
        assert.equal(observed.application,'cleanup-url-fixture'); assert.equal(observed.timezone,'Asia/Seoul');
        assert.equal(observed.ssl,false); assert.equal(observed.port,Number(process.env.PG_PORT));
        if (blocked) {
          await queued;
          assert.equal((await lockError)[0].code,'55P03','native DB cancels blocked lock, not only parent termination');
          assert.deepEqual(await running,{status:'failed',reason:'busy'});
          assert.equal((await native.pool.query('SELECT count(*)::int AS n FROM accounting.expense_import_uploads WHERE id=$1',[uploadId])).rows[0].n,1);
        } else assert.deepEqual(await running,{status:'succeeded',deleted:1,redacted:0});
        assert.equal(parentDeadlineFired,false); assert.equal(workerExited,true);
        assert.equal(config.connectionEnv.DATABASE_URL,url.href,'worker policy must not mutate server/API config');
        console.log(JSON.stringify({scenario,...observed,nativeLockCancelled:blocked,parentDeadlineFired,workerExited}));
      } finally {
        abort.abort(); await running;
        // Consume bounded observation rejections on RED paths without hiding the failing assertion.
        await observationsSettled;
        if (claimant) { await claimant.query('ROLLBACK'); claimant.release(); }
        channel.port1.close(); channel.port2.close();
        await native.pool.query('DELETE FROM accounting.expense_import_uploads WHERE id=$1',[uploadId]);
      }
    });
  } finally { await native.close(); }
});
