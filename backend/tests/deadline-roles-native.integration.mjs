import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';
import { startDeadlineServer } from './deadline-fixture.js';
import { COMPANY_PERMISSIONS } from '../src/config/rbac.js';

// 네이티브 PG18의 회사 행 잠금과 실제 HTTP 동시 요청. SQL 응답 대체 없음.
test('native PG18: scoped HTTP CAS, delegation, rollback and two-admin removal race', { timeout: 120000 }, async () => {
  const bin = process.env.ORG_TEST_PG_BIN;
  assert.ok(bin, 'runner --pg-bin required');
  const evidence = new URL('../../.omo/evidence/task-2-deadline-erp-redesign/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(process.env.DEADLINE_TEMP_ROOT, 'roles-native-')), data = path.join(root, 'data');
  const resource = { root, port: null, pid: null, stopped: false, temporaryRemoved: false };
  const result = { status:'running', race:null, resources:[resource], http:[] };
  let api, pool, appPool, started = false;
  function run(command, args) {
    const log = path.join(root, `${command}.log`), fd = openSync(log, 'w');
    let child;
    try { child = spawnSync(path.join(bin, `${command}.exe`), args, { stdio:['ignore',fd,fd], timeout:60000 }); }
    finally { closeSync(fd); }
    assert.equal(child.status, 0, `${command}: ${child.error ?? readFileSync(log,'utf8')}`);
  }
  try {
    api = await startDeadlineServer();
    const reservation = net.createServer();
    const listening = once(reservation,'listening', { signal:AbortSignal.timeout(5000) });
    reservation.listen(0,'127.0.0.1'); await listening;
    resource.port = reservation.address().port;
    await new Promise((resolve,reject) => reservation.close(error => error ? reject(error) : resolve()));
    run('initdb',['-D',data,'-U','deadline_roles','-A','trust','--encoding=UTF8','--locale=C']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${resource.port}`,'-w','start']); started = true;
    resource.pid = Number((await readFile(path.join(data,'postmaster.pid'),'utf8')).split('\n')[0]);
    const config = { host:'127.0.0.1',port:resource.port,database:'postgres',user:'deadline_roles',password:'',connectionTimeoutMillis:5000 };
    pool = new pg.Pool(config);
    ({ pgPool:appPool } = await import('../src/config/pg.js'));
    Object.assign(appPool.options, config);
    for (const file of ['perp_schema.sql', ...[2,3,4,5,6,7].map(v=>`perp_additions_v${v}.sql`), 'perp_additions_v10_org_audit.sql', 'perp_additions_v11_deadline_roles.sql','perp_additions_v11_deadline_roles.sql']) {
      await pool.query(await readFile(new URL(`../../db/${file}`,import.meta.url),'utf8'));
    }
    result.engine = (await pool.query('SELECT version()')).rows[0].version;
    const req = (...args) => api.request(...args);
    async function company(name) {
      const user = await req(null,'/pg/auth/signup','POST',{ email:`${name}@example.invalid`,name,password:'password-1234' },201);
      const actor = { token:user.token,userId:String(user.user.id) };
      const company = await req(actor,'/pg/companies','POST',{name,modules:['projects','tasks'],features:[],departments:[]},201);
      actor.orgId = company.org_id;
      return actor;
    }
    const admin = await company('NATIVE_ROLE_A'), foreign = await company('NATIVE_ROLE_B');
    result.identities = { companyA:admin.orgId,companyB:foreign.orgId,admin:admin.userId,foreign:foreign.userId };
    const createdMember = await req(admin,'/pg/members','POST',{email:'native-member@example.invalid',name:'구성원',password:'password-1234'},201);
    const login = await req(null,'/pg/auth/login','POST',{email:'native-member@example.invalid',password:'password-1234'});
    const member = { token:login.token,userId:createdMember.id,orgId:admin.orgId };
    const create = (name,permissions,actor=admin) => req(actor,'/settings/roles','POST',{name,permissions,scope:'all'},201);
    const assign = async (actor, target, roles, expected=200) => {
      const current = (await req(actor,'/settings/members')).items.find(row=>row.membership_id===target);
      return req(actor,`/settings/members/${target}/roles`,'PUT',{roles,expected_roles_version:current.roles_version},expected);
    };
    const role = await create('버전 역할',['task.read','menu.projects']); assert.equal(role.version,1);
    await req(admin,`/settings/roles/${role.key}`,'PATCH',{name:role.name,scope:'all',permissions:[],expected_version:1});
    await req(admin,`/settings/roles/${role.key}`,'PATCH',{name:role.name,scope:'all',permissions:[],expected_version:1},409);
    await req(admin,`/settings/roles/${role.key}`,'DELETE',{},400);
    const foreignRole = await create('외부',[],foreign);
    for (const key of [foreignRole.key,'*','platform_admin','unknown']) await assign(admin,member.userId,[key],key==='platform_admin'?403:400);
    const limited = await create('위임 없음',['menu.roles','menu.members','member.write']);
    await assign(admin,member.userId,[limited.key]);
    await req(member,'/settings/roles','POST',{name:'금지',permissions:[]},403);
    await req(member,'/pg/members','POST',{email:'denied@example.invalid',name:'금지',password:'password-1234'},403);
    await req(member,'/pg/members/invites','POST',{email:'denied@example.invalid'},403);
    await req({...admin,orgId:foreign.orgId},'/settings/roles','GET',undefined,403);
    const snapshot = async () => (await pool.query(`SELECT jsonb_build_object(
      'roles',(SELECT jsonb_agg(r ORDER BY id) FROM org.roles r),
      'grants',(SELECT jsonb_agg(g ORDER BY user_id,role_id) FROM org.user_roles g),
      'permissions',(SELECT jsonb_agg(p ORDER BY role_id,permission_id) FROM org.role_permissions p),
      'members',(SELECT jsonb_agg(m ORDER BY company_id,user_id) FROM org.company_memberships m),
      'events',(SELECT jsonb_agg(e ORDER BY id) FROM org.role_change_events e)) AS state`)).rows[0].state;
    const corrupt = await create('기존 비회사 권한',[]);
    await pool.query("INSERT INTO org.permissions(code,module) VALUES ('*','legacy'),('platform.tenants','platform') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT $1,id FROM org.permissions WHERE code IN ('*','platform.tenants')",[corrupt.key]);
    const corruptBefore = await snapshot();
    await assign(admin,member.userId,[corrupt.key],403);
    assert.deepEqual(await snapshot(),corruptBefore,'existing non-company grants are refused, not erased or promoted');
    const before = await snapshot();
    await pool.query(`CREATE FUNCTION org.fail_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deadline injected audit failure'; END $$;
      CREATE TRIGGER deadline_audit_failure BEFORE INSERT ON org.role_change_events FOR EACH ROW EXECUTE FUNCTION org.fail_role_audit()`);
    try { await req(admin,'/settings/roles','POST',{name:'rollback',permissions:[],scope:'all'},500); }
    finally { await pool.query('DROP TRIGGER deadline_audit_failure ON org.role_change_events'); }
    assert.deepEqual(await snapshot(),before);
    const split = Math.ceil(COMPANY_PERMISSIONS.length/2);
    const left = await create('합집합 왼쪽',COMPANY_PERMISSIONS.slice(0,split));
    const right = await create('합집합 오른쪽',COMPANY_PERMISSIONS.slice(split));
    await assign(admin,member.userId,[left.key,right.key]);
    const members = (await req(admin,'/settings/members')).items;
    async function blockedMutations(count, start, whileBlocked = async () => {}) {
      const external = await pool.connect(), originalConnect = appPool.connect;
      const pids = []; let ready, timer, requests;
      await external.query('BEGIN');
      await external.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE',[admin.orgId.slice(3)]);
      const blocked = new Promise((resolve,reject)=>{ ready=resolve; timer=setTimeout(()=>reject(new Error('native company-lock arrivals missing')),10000); });
      appPool.connect = function(callback) {
        if (callback) return originalConnect.call(this,callback);
        return originalConnect.call(this).then(client=>{
          const originalQuery = client.query, originalRelease = client.release;
          client.query = function(sql,...args) {
            const pending = originalQuery.call(this,sql,...args);
            if (String(sql).includes('FROM org.companies') && String(sql).includes('FOR UPDATE')) {
              pids.push(client.processID); if (pids.length===count) ready();
            }
            return pending;
          };
          client.release = function(...args) { client.query=originalQuery; client.release=originalRelease; return originalRelease.apply(this,args); };
          return client;
        });
      };
      try {
        requests = Promise.allSettled(start());
        await blocked;
        assert.equal(new Set(pids).size,count);
        await whileBlocked(external);
        await external.query('COMMIT');
        const settled = await requests;
        const errors = settled.filter(row=>row.status==='rejected').map(row=>row.reason);
        if(errors.length) throw new AggregateError(errors,'native requests failed');
        return {pids,outcomes:settled.map(row=>row.value)};
      } finally {
        clearTimeout(timer); appPool.connect=originalConnect;
        try { await external.query('ROLLBACK'); } finally { external.release(); }
        await requests;
      }
    }
    // 두 트랜잭션 모두 동일 회사 lock에 도달한 신호를 받은 뒤에만 해제한다.
    const {pids,outcomes} = await blockedMutations(2,()=>[admin,member].map(async actor=>{
      const route = `/settings/members/${actor.userId}/roles`;
      const response = await fetch(api.baseUrl+route,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor.token}`,'X-Org-Id':actor.orgId},
        body:JSON.stringify({roles:[],expected_roles_version:members.find(row=>row.user_id===actor.userId).roles_version}),signal:AbortSignal.timeout(15000)});
      const record = {route,actor:actor.userId,status:response.status,body:await response.json()}; api.http.push(record); return record;
    }));
    result.race = {nativeBackendPids:pids,statuses:outcomes.map(row=>row.status).sort(),outcomes};
    assert.deepEqual(result.race.statuses,[200,409]);
    const survivor = [admin,member].find(actor=>outcomes.find(row=>row.actor===actor.userId).status===409);
    assert.equal((await req(survivor,'/settings/roles')).recovery_required,false);
    // 분할 union을 유일한 관리자에게 다시 배정하여 정의 축소도 실제 PG에서 검증한다.
    await assign(survivor,survivor.userId,[left.key,right.key]);
    await req(survivor,`/settings/roles/${left.key}`,'DELETE',{expected_version:left.version},409);
    await req(survivor,`/settings/roles/${right.key}`,'PATCH',{name:right.name,scope:'all',permissions:[],expected_version:right.version},409);
    const stable = await snapshot();
    await assign(survivor,survivor.userId,[left.key,right.key]);
    await req(survivor,`/settings/roles/${right.key}`,'PATCH',{name:right.name,scope:'all',permissions:right.permissions,expected_version:right.version});
    assert.deepEqual(await snapshot(),stable,'native no-op cannot increment versions or audit');
    const removed = [admin,member].find(actor=>actor!==survivor);
    await assign(survivor,removed.userId,['company_admin']);
    const removedVersion = (await req(survivor,'/settings/members')).items.find(row=>row.user_id===removed.userId).roles_version;
    let afterRevocation;
    await blockedMutations(1,()=>[req(removed,`/settings/members/${removed.userId}/roles`,'PUT',{roles:[],expected_roles_version:removedVersion-1},403)],async client=>{
      await client.query(`DELETE FROM org.user_roles ur USING org.roles r WHERE ur.role_id=r.id AND r.company_id=$1 AND ur.user_id=$2 AND ur.workspace_id IS NULL`,[admin.orgId.slice(3),removed.userId]);
      await client.query('UPDATE org.company_memberships SET roles_version=roles_version+1 WHERE company_id=$1 AND user_id=$2',[admin.orgId.slice(3),removed.userId]);
      afterRevocation = true;
    });
    assert.equal(afterRevocation,true); result.revokedWhileQueued = {status:403,staleVersion:removedVersion-1};
    result.status='passed';
  } catch(error) { result.status='failed'; result.error=error.stack; throw error; }
  finally {
    result.http=api?.http ?? [];
    const cleanupErrors=[];
    for(const close of [()=>api?.close(),()=>pool?.end(),()=>{if(started){run('pg_ctl',['-D',data,'-m','fast','-w','stop']);resource.stopped=true;}}]) {
      try {await close();} catch(error){cleanupErrors.push(error);}
    }
    if(!started || resource.stopped) {await rm(root,{recursive:true,force:true});resource.temporaryRemoved=!existsSync(root);}
    if(cleanupErrors.length) result.status='failed';
    await writeFile(new URL('native.json',evidence),JSON.stringify(result,null,2));
    await writeFile(new URL('native-cleanup.json',evidence),JSON.stringify({resource,api:api?.resource,errors:cleanupErrors.map(error=>error.message)},null,2));
    if(cleanupErrors.length) throw new AggregateError(cleanupErrors,'native cleanup failed');
  }
});
