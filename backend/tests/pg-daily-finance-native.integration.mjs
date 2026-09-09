import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startTestServer } from './http.js';
import { competeNative } from './native-finance-race.js';

// Opt-in, task-owned native PostgreSQL cluster. Never accepts an existing DB URL.
const bin = process.env.FINANCE_TEST_PG_BIN;
if (!bin) throw new Error('FINANCE_TEST_PG_BIN must point to isolated PostgreSQL binaries');
const root = await mkdtemp(path.join(tmpdir(), 'perp-finance-native-'));
const data = path.join(root, 'data');
function run(command, args) {
  const log = path.join(root, `${command}.log`), fd = openSync(log, 'w');
  let result;
  try { result = spawnSync(path.join(bin, command + (process.platform === 'win32' ? '.exe' : '')), args, { stdio: ['ignore',fd,fd], timeout: 60000 }); }
  finally { closeSync(fd); }
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error ?? result.status}\n${readFileSync(log,'utf8')}`);
}
const inheritedConnectionTimeout = Number(process.env.PG_CONNECTION_TIMEOUT_MS);
let started = false, database, server, appPool, failure;
try {
  const reservation = net.createServer();
  await new Promise((resolve,reject) => { reservation.once('error',reject); reservation.listen(0,'127.0.0.1',resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  run('initdb',['-D',data,'-U','finance_test','-A','trust','--encoding=UTF8','--locale=C']);
  run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
  started = true;
  process.env.DATABASE_URL = '';
  process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = String(port);
  process.env.PG_DATABASE = 'postgres'; process.env.PG_USER = 'finance_test'; process.env.PG_PASSWORD = '';
  // This owned live cluster uses the same bounded acquisition budget as the
  // daily/org native fixtures, not the runner's unavailable-dependency 100 ms.
  process.env.PG_CONNECTION_TIMEOUT_MS = '5000';
  database = new pg.Pool({ host:'127.0.0.1',port,database:'postgres',user:'finance_test',connectionTimeoutMillis:5000 });
  for (const name of ['perp_schema.sql',...[2,3,4,5,6,7].map(n=>`perp_additions_v${n}.sql`),'perp_additions_v8_daily_finance.sql','perp_additions_v8_daily_finance.sql','perp_additions_v9_daily_corrections.sql','perp_additions_v10_org_audit.sql','perp_additions_v11_deadline_roles.sql','perp_additions_v12_deadline_expenses.sql','perp_additions_v12_deadline_expense_writer.sql']) {
    await database.query(await readFile(new URL(`../../db/${name}`,import.meta.url),'utf8'));
  }
  await database.query(`INSERT INTO org.companies(name) VALUES('Native finance fixture');
    INSERT INTO auth.users(company_id,email,name,password_hash,approval_status) VALUES(1,'native-finance@example.invalid','Native finance','not-a-secret','approved');
    INSERT INTO org.company_memberships(company_id,user_id) VALUES(1,1);
    INSERT INTO org.roles(company_id,name) VALUES(1,'explicit_finance_test_role');
    INSERT INTO org.user_roles(user_id,role_id) VALUES(1,1);
    INSERT INTO org.company_modules(company_id,module_key) VALUES(1,'finance'),(1,'assets'),(1,'approvals');
    INSERT INTO org.company_feature_settings(company_id,enabled_features) VALUES(1,ARRAY['approvals']);
    INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES(1,'100','Cash','asset'),(1,'400','Revenue','revenue');`);
  const permissions=['transaction.read','transaction.write','budget.read','budget.write','settlement.create','dues.read','dues.write','asset.read','asset.write','approval.request','approval.decide','menu.finance','menu.assets','menu.approvals','menu.configured'];
  await database.query("INSERT INTO org.permissions(code,module) SELECT code,split_part(code,'.',1) FROM unnest($1::text[]) code",[permissions]);
  await database.query('INSERT INTO org.role_permissions(role_id,permission_id) SELECT 1,id FROM org.permissions');
  const token=randomUUID(); await database.query('INSERT INTO auth.sessions(user_id,session_token) VALUES(1,$1)',[token]);
  console.log(JSON.stringify({engine:(await database.query('SELECT version()')).rows[0].version,host:'127.0.0.1',port,temporaryCluster:root}));
  server=await startTestServer(); appPool=(await import('../src/config/pg.js')).pgPool;
  const { env } = await import('../src/config/env.js');
  const configurationClient = await appPool.connect();
  try {
    const timeoutConfig = { inherited: inheritedConnectionTimeout, environment: Number(process.env.PG_CONNECTION_TIMEOUT_MS),
      captured: env.pg.connectionTimeoutMillis, applicationPool: appPool.options.connectionTimeoutMillis,
      applicationClient: configurationClient._connectionTimeoutMillis, fixturePool: database.options.connectionTimeoutMillis ?? 0,
      poolMax: appPool.options.max, backendPid: configurationClient.processID,
      sql: (await configurationClient.query("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout")).rows[0] };
    console.log(JSON.stringify({ NATIVE_FINANCE_TIMEOUT_CONFIG: timeoutConfig }));
    assert.deepEqual([timeoutConfig.environment, timeoutConfig.captured, timeoutConfig.applicationPool, timeoutConfig.applicationClient, timeoutConfig.fixturePool],
      [5000, 5000, 5000, 5000, 5000], 'Owned native PG must not inherit the unavailable-dependency acquisition deadline');
    assert.deepEqual(timeoutConfig.sql, { lock_timeout: '0', statement_timeout: '0' });
  } finally { configurationClient.release(); }
  const request=async(route,method='GET',body,key=randomUUID(),signal=AbortSignal.timeout(15000))=>{
    const response=await fetch(server.baseUrl+'/pg'+route,{method,signal,
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Org-Id':'pg:1','Idempotency-Key':key},
      body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text(); return {status:response.status,body:text?JSON.parse(text):null};
  };
  const transaction={account_id:'2',amount:'10.01'};
  const tables=['accounting.journal_entries','accounting.journal_lines','asset.assets','asset.history','accounting.budgets','accounting.settlements','accounting.dues_charges','accounting.dues_payments','accounting.record_events','org.approval_requests','org.role_change_events'];
  const snapshot=()=>Promise.all([...tables.map(async table=>(await database.query(`SELECT * FROM ${table} ORDER BY id`)).rows),database.query('SELECT * FROM accounting.request_replays ORDER BY company_id,actor_id,operation,request_key').then(r=>r.rows)]);
  await database.query(`CREATE FUNCTION accounting.fail_native_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected native financial write failure'; END $$`);
  async function failWrite(table,event,invoke,condition='') {
    const before=await snapshot();
    await database.query(`CREATE TRIGGER native_failure BEFORE ${event} ON ${table} FOR EACH ROW ${condition ? `WHEN (${condition})` : ''} EXECUTE FUNCTION accounting.fail_native_write()`);
    try { const result=await invoke(); assert.equal(result.status,500,`${table}/${event}: ${JSON.stringify(result.body)}`); assert.deepEqual(await snapshot(),before); }
    finally { await database.query(`DROP TRIGGER native_failure ON ${table}`); }
    console.log(`PASS native rollback ${table}/${event}${condition ? '/'+condition : ''}`);
  }
  for (const [table,event,condition] of [['accounting.request_replays','INSERT'],['accounting.journal_entries','INSERT'],['accounting.journal_lines','INSERT','NEW.debit > 0'],['accounting.journal_lines','INSERT','NEW.credit > 0'],['accounting.journal_entries','UPDATE'],['accounting.request_replays','UPDATE']]) {
    await failWrite(table,event,()=>request('/finance/transactions','POST',transaction),condition);
  }
  for (const [table,route,body] of [['asset.assets','/assets',{name:'Native asset'}],['asset.history','/assets',{name:'Native asset'}],['accounting.budgets','/finance/budgets',{name:'Native budget',amount:'100.01'}],['accounting.settlements','/finance/settlements',{title:'Native settlement',amount:'100.01'}],['accounting.dues_charges','/finance/dues',{target_user_id:'1',amount:'100.01'}]]) {
    await failWrite(table,'INSERT',()=>request(route,'POST',body));
  }

  const compete=(first,second)=>competeNative(appPool,database,first,second);
  const key=randomUUID();
  const duplicates=await compete(signal=>request('/finance/transactions','POST',transaction,key,signal),signal=>request('/finance/transactions','POST',transaction,key,signal));
  assert.deepEqual(duplicates.map(r=>r.status),[201,201]); assert.equal(duplicates[0].body.id,duplicates[1].body.id);
  const entry=duplicates[0].body.id;
  assert.equal((await database.query('SELECT count(*)::int AS n FROM accounting.journal_entries')).rows[0].n,1);
  assert.deepEqual((await database.query('SELECT SUM(debit)::text AS debit,SUM(credit)::text AS credit FROM accounting.journal_lines WHERE entry_id=$1',[entry])).rows,[{debit:'10.01',credit:'10.01'}]);
  assert.equal((await request('/finance/transactions','POST',{...transaction,amount:'20.01'},key)).status,409);
  assert.equal((await request(`/records/transactions/${entry}`,'DELETE',{expected_version:1})).status,409);
  await assert.rejects(database.query('DELETE FROM accounting.journal_entries WHERE id=$1',[entry]),/posted journal retained/);
  await assert.rejects(database.query('DELETE FROM accounting.journal_lines WHERE entry_id=$1',[entry]),/posted journal lines retained/);

  const budget=await request('/finance/budgets','POST',{name:'Audit rollback budget',amount:'100.01'}); assert.equal(budget.status,201);
  await failWrite('accounting.record_events','INSERT',()=>request(`/records/budgets/${budget.body.id}`,'PATCH',{amount:'90.01',expected_version:1}));
  await failWrite('accounting.record_events','INSERT',()=>request(`/records/budgets/${budget.body.id}`,'DELETE',{expected_version:1}));
  const charge=await request('/finance/dues','POST',{target_user_id:'1',amount:'100.01'}); assert.equal(charge.status,201);
  const paymentRoute=`/finance/dues/${charge.body.id}/payments`, payment={amount:'40.01',expected_version:1};
  for (const [table,event] of [['accounting.dues_payments','INSERT'],['accounting.dues_charges','UPDATE'],['accounting.record_events','INSERT'],['accounting.request_replays','UPDATE']]) {
    await failWrite(table,event,()=>request(paymentRoute,'POST',payment));
  }
  const paymentKey=randomUUID();
  const paid=await compete(signal=>request(paymentRoute,'POST',payment,paymentKey,signal),signal=>request(paymentRoute,'POST',payment,randomUUID(),signal));
  assert.deepEqual(paid.map(r=>r.status).sort(),[201,409]);
  const history=await request(paymentRoute); assert.equal(history.body.items.length,1); assert.equal(history.body.outstanding,'60.00');
  assert.equal((await request(paymentRoute,'POST',{amount:'60.00',expected_version:2})).status,201);
  const complete=await request(paymentRoute); assert.equal(complete.body.items.length,2); assert.equal(complete.body.outstanding,'0.00'); assert.equal(complete.body.status,'paid');
  await assert.rejects(database.query('DELETE FROM accounting.dues_charges WHERE id=$1',[charge.body.id]),/paid charge retained/);
  await assert.rejects(database.query('DELETE FROM accounting.dues_payments WHERE charge_id=$1',[charge.body.id]),/history retained/);

  const approval=await request('/approvals','POST',{request_type:'Native one-time decision'}); assert.equal(approval.status,201);
  const decisionRoute=`/approvals/${approval.body.id}/decide`;
  await failWrite('org.approval_requests','UPDATE',()=>request(decisionRoute,'POST',{decision:'approve'}));
  await failWrite('org.role_change_events','INSERT',()=>request(decisionRoute,'POST',{decision:'approve'}));
  const decisions=await compete(signal=>request(decisionRoute,'POST',{decision:'approve'},randomUUID(),signal),signal=>request(decisionRoute,'POST',{decision:'reject'},randomUUID(),signal));
  assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM org.role_change_events WHERE action='approval.decided'")).rows[0].n,1);
  assert.equal((await request('/finance/transactions','POST',{account_id:'2',amount:'9999999999999999.99'})).status,201);
  assert.equal((await request('/finance/summary')).body.수입,'10000000000000010.00');
  console.log('PASS native PG HTTP: every financial write rollback, real concurrent replay once, balanced journal, correction audit rollback, partial/remainder/history, version conflict, decision once, retention triggers, exact summary');
} catch (error) { failure = error; throw error; }
finally {
  const cleanupErrors = [];
  for (const [name, close] of [['application-pool', () => appPool?.end()], ['http-server', () => server?.close()],
    ['fixture-pool', () => database?.end()], ['native-cluster', () => { if(started) run('pg_ctl',['-D',data,'-m','fast','-w','stop']); }],
    ['temporary-root', () => rm(root,{recursive:true,force:true})]]) {
    let timer;
    try {
      await Promise.race([Promise.resolve().then(close), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native finance cleanup deadline: ${name}`)), 10000);
      })]);
    } catch (error) { cleanupErrors.push(error); }
    finally { clearTimeout(timer); }
  }
  console.log(JSON.stringify({ NATIVE_FINANCE_CLEANUP: { root, errors: cleanupErrors.map(error => ({ message: error.message, stack: error.stack })) } }));
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Native finance failure/cleanup');
  console.log('DAILY_FINANCE_NATIVE_CLUSTER_AND_SERVICES_CLEANED');
}
