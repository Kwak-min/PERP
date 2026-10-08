import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureJsonResponse } from './deadline-approval-responses.mjs';

async function changeStorage(page, trigger) {
  await page.evaluate(() => {
    window.__approvalStorageSignal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('storage', changed); reject(new Error('Storage event deadline')); }, 15000);
      function changed(event) { if (event.key === 'orbitflow.session.v1') { clearTimeout(timer); window.removeEventListener('storage', changed); resolve(); } }
      window.addEventListener('storage', changed);
    });
  });
  await Promise.all([page.evaluate(() => window.__approvalStorageSignal), trigger()]);
}

export async function extendedWorkflow({ store, owner, other, page, context, origin, linked, rejected, surface, action, rendered, request, native, attempt, result }) {
  const base = store === 'pg' ? '/pg/approvals' : '/approvals/requests';
  const url = id => origin + `/approvals?request=${encodeURIComponent(id)}`;
  const editorSave = () => page.locator('[data-approval-editor]').getByRole('button',{name:'임시저장',exact:true}).click();
  // 앞선 반려 원본은 새 초안을 제출/승인해도 바뀌지 않는다.
  await page.goto(url(linked.id)); await rendered(page,'[data-form-revision="2"]');
  await page.getByLabel('제목',{exact:true}).focus(); await page.keyboard.press('End'); await page.keyboard.type(' edited');
  for(const width of [375,768,1280]) {
    await page.setViewportSize({width,height:900}); await page.evaluate(()=>{window.scrollTo({top:0,behavior:'instant'}); return document.fonts.ready;});
    const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})); assert.ok(geometry.scroll<=width,JSON.stringify(geometry));
    const screenshot=`${store}-editor-${width}.png`; await page.screenshot({path:path.join(attempt,screenshot),fullPage:true,animations:'disabled'}); result.surfaces.push({store,width,geometry,screenshot});
  }
  await page.setViewportSize({width:1280,height:900});
  await action(page,'/submit',()=>page.getByRole('button',{name:'제출',exact:true}).click());
  if(store==='pg') await page.getByLabel('본인 요청을 직접 결정함을 확인합니다').check();
  else await page.getByLabel('재인증 비밀번호').fill('password-1234');
  const approved=await action(page,'/actions',()=>page.getByRole('button',{name:'승인',exact:true}).click()); assert.equal(approved.status,'approved');
  assert.equal(approved.body.amount_krw,store==='pg'?'9007199254740991.23':'1000000.00');
  if(store==='sqlite') assert.equal(approved.amount,100000000);
  const originalResponse=captureJsonResponse(page,r=>new URL(r.url()).pathname==='/api/v1'+base+'/'+rejected.id,result);
  await page.getByRole('link',{name:'이전 요청 원본',exact:true}).click();
  assert.deepEqual((await originalResponse).body,rejected);
  await rendered(page,`[data-approval-detail="${rejected.id}"]`);

  // 동명이인 요청은 표시 이름이 같아도 내 요청으로 분류하지 않는다. 실제 다른 요청자가 기안한다.
  const peer=await surface(other); let peerDraft;
  try {
    await peer.page.goto(origin+'/approvals'); await rendered(peer.page,'[data-approval-create]'); await peer.page.locator('[data-approval-create]').click(); await rendered(peer.page,'[data-form-revision="1"]');
    await peer.page.getByLabel('제목',{exact:true}).fill('Same-name peer request'); await peer.page.getByLabel('목적 (필수)',{exact:true}).fill('Peer-only body');
    if(store==='sqlite') await peer.page.getByLabel('결재자 1',{exact:true}).selectOption(owner.id);
    peerDraft=await action(peer.page,'/drafts',()=>peer.page.locator('[data-approval-editor]').getByRole('button',{name:'임시저장',exact:true}).click(),201);
    await rendered(peer.page,`[data-approval-detail="${peerDraft.id}"]`); await rendered(peer.page,'[data-form-revision="1"]');
    // 현재 권한 회수에 따른 403은 초안을 지우지 않는다. 설정 변경은 합성 fixture에만 적용한다.
    if(store==='pg') {
      await native.pool.query("DELETE FROM org.role_permissions WHERE role_id IN (SELECT role_id FROM org.user_roles WHERE user_id=$1) AND permission_id=(SELECT id FROM org.permissions WHERE code='approval.request')",[other.id]);
      await peer.page.getByLabel('목적 (필수)',{exact:true}).fill('Unsaved after403');
      await action(peer.page,'/draft',()=>peer.page.locator('[data-approval-editor]').getByRole('button',{name:'임시저장',exact:true}).click(),403);
      assert.equal(await peer.page.getByLabel('목적 (필수)',{exact:true}).inputValue(),'Unsaved after403');
      await native.pool.query("INSERT INTO org.role_permissions(role_id,permission_id) SELECT ur.role_id,p.id FROM org.user_roles ur CROSS JOIN org.permissions p WHERE ur.user_id=$1 AND p.code='approval.request' ON CONFLICT DO NOTHING",[other.id]);
    } else {
      const { db } = await import('../../backend/src/config/db.js');
      const membership=db().prepare('SELECT id,roles FROM membership WHERE org_id=? AND user_id=?').get(other.orgId,other.id);
      db().prepare("UPDATE membership SET roles='' WHERE id=?").run(membership.id);
      try {
        await peer.page.getByLabel('목적 (필수)',{exact:true}).fill('Unsaved after403');
        await action(peer.page,'/draft',()=>peer.page.locator('[data-approval-editor]').getByRole('button',{name:'임시저장',exact:true}).click(),403);
        assert.equal(await peer.page.getByLabel('목적 (필수)',{exact:true}).inputValue(),'Unsaved after403');
      } finally { db().prepare('UPDATE membership SET roles=? WHERE id=?').run(membership.roles,membership.id); }
    }
    await action(peer.page,'/submit',()=>peer.page.getByRole('button',{name:'제출',exact:true}).click());
    assert.equal(await peer.page.getByRole('button',{name:'승인',exact:true}).count(),0);
    // 요청자가 실제 UI로 철회하고 연결 초안을 새로 만든다.
    const withdrawn=await action(peer.page,'/withdraw',()=>peer.page.getByRole('button',{name:'요청 철회',exact:true}).click()); assert.equal(withdrawn.status,'withdrawn');
    const next=await action(peer.page,'/resubmit',()=>peer.page.getByRole('button',{name:'새 초안으로 재상신',exact:true}).click(),201);
    assert.equal(next.predecessor_id,peerDraft.id); assert.notEqual(next.id,peerDraft.id);
    peerDraft=next;
    await rendered(peer.page,`[data-approval-detail="${next.id}"]`); await rendered(peer.page,'[data-form-revision="1"]');
    await action(peer.page,'/submit',()=>peer.page.getByRole('button',{name:'제출',exact:true}).click());
  } finally { await peer.context.close(); }
  const inboxResponse=captureJsonResponse(page,r=>new URL(r.url()).pathname==='/api/v1'+base,result);
  await page.getByRole('navigation',{name:'결재함'}).getByRole('button',{name:'처리할 요청',exact:true}).click(); await inboxResponse;
  await rendered(page,`[data-approval-row="${peerDraft.id}"]`);
  await page.locator(`[data-approval-row="${peerDraft.id}"] a`).click(); await rendered(page,'[data-approval-status="pending"]');
  assert.equal(await page.getByLabel('본인 요청을 직접 결정함을 확인합니다').count(),0);
  const peerApproved=await action(page,'/actions',()=>page.getByRole('button',{name:'승인',exact:true}).click()); assert.equal(peerApproved.status,'approved');
  const ownResponse=captureJsonResponse(page,r=>new URL(r.url()).pathname==='/api/v1'+base,result);
  await page.getByRole('navigation',{name:'결재함'}).getByRole('button',{name:'내 요청',exact:true}).click(); const ownRows=(await ownResponse).body;
  await rendered(page,`[data-approval-row="${approved.id}"]`);
  assert.equal(await page.locator(`[data-approval-row="${peerDraft.id}"]`).count(),0);
  if(store==='pg') {
    const peerRow=ownRows.items.find(row=>row.__id===peerDraft.id); assert.equal(peerRow.requester_id,other.id);
    assert.equal(peerRow.신청자,owner.name); assert.notEqual(peerRow.requester_id,owner.id);
  }
  const completedResponse=captureJsonResponse(page,r=>new URL(r.url()).pathname==='/api/v1'+base,result);
  await page.getByRole('navigation',{name:'결재함'}).getByRole('button',{name:'처리완료',exact:true}).click(); await completedResponse;
  await rendered(page,`[data-approval-row="${peerDraft.id}"]`);
  result.extended??=[]; result.extended.push({store,approved:approved.id,unchangedRejected:rejected.id,peer:peerDraft.id,ownIdentity:owner.id,peerIdentity:other.id});

  // 실제 두 UI의 경합: 정확한 CAS가 실패해도 로컬 입력은 유지되고 명시적 최신 버전 확인 후에만 재저장한다.
  await page.locator('[data-approval-create]').click(); await rendered(page,'[data-form-revision="1"]');
  await page.getByLabel('제목',{exact:true}).fill('CAS local title'); await page.getByLabel('목적 (필수)',{exact:true}).fill('CAS original');
  if(store==='sqlite') await page.getByLabel('결재자 1',{exact:true}).selectOption(owner.id);
  const cas=await action(page,'/drafts',editorSave,201); await rendered(page,`[data-approval-detail="${cas.id}"]`); await rendered(page,'[data-form-revision="1"]');
  const second=await surface(owner);
  try {
    await second.page.goto(url(cas.id)); await rendered(second.page,'[data-form-revision="1"]');
    await second.page.getByLabel('목적 (필수)',{exact:true}).fill('Other browser saved');
    const changed=await action(second.page,'/draft',()=>second.page.locator('[data-approval-editor]').getByRole('button',{name:'임시저장',exact:true}).click());
    await page.getByLabel('목적 (필수)',{exact:true}).fill('Local remains on409');
    await action(page,'/draft',editorSave,409); assert.equal(await page.getByLabel('목적 (필수)',{exact:true}).inputValue(),'Local remains on409');
    const refreshed=captureJsonResponse(page,r=>new URL(r.url()).pathname==='/api/v1'+base+'/'+cas.id,result);
    await page.getByRole('button',{name:'최신 버전 확인 (입력 유지)',exact:true}).click(); assert.equal((await refreshed).body.version,changed.version);
    await rendered(page,'[data-operation-state="idle"]');
    const saved=await action(page,'/draft',editorSave); assert.equal(saved.version,changed.version+1); assert.equal(saved.body.purpose,'Local remains on409');
  } finally { await second.context.close(); }
  // 잘못된 파일은 실제 업로드 경계에서 거절되며 입력을 유지한다.
  await action(page,'/receipt-uploads',()=>page.getByLabel('첨부 파일').setInputFiles({name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('not-a-png')}),400);
  assert.equal(await page.getByLabel('목적 (필수)',{exact:true}).inputValue(),'Local remains on409');
  if(store==='pg') {
    // 회사 전환은 실제 회사 선택기로 한다. 응답 지연은 실제 서버 응답을 획득한 뒤 이벤트 gate로 제어한다.
    const otherCompany=await request(owner,'/pg/companies','POST',{name:'T23_SWITCH_B',modules:['approvals'],features:['approvals']},201);
    // 인증 조직 목록 동기화: 다른 탭에서 저장된 세션을 브라우저 storage 이벤트로 받는 실제 경계다.
    const organization={org_id:otherCompany.org_id,org_name:'T23_SWITCH_B',org_type:'custom',roles:['owner']};
    const authTab=await context.newPage(); await authTab.goto(origin+'/approvals'); await rendered(authTab,'[data-approval-create]');
    await changeStorage(page,()=>authTab.evaluate(organization=>{const key='orbitflow.session.v1',state=JSON.parse(localStorage.getItem(key)); state.organizations.push(organization); localStorage.setItem(key,JSON.stringify(state));},organization));
    await authTab.close();
    const reached=Promise.withResolvers(),release=Promise.withResolvers(),settled=Promise.withResolvers();
    const gatePath='**/api/v1'+base+'/'+cas.id+'/draft';
    await context.route(gatePath,async route=>{
      try { const response=await route.fetch(); const body=await response.body(); reached.resolve({status:response.status(),body:JSON.parse(body)}); await release.promise; await route.fulfill({response,body}); }
      catch(error) { settled.reject(error); return; }
      settled.resolve();
    });
    try {
      await page.getByLabel('목적 (필수)',{exact:true}).fill('Old company staged submit');
      const gateDeadline=AbortSignal.timeout(15000);
      const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>gateDeadline.addEventListener('abort',()=>reject(new Error('Scope gate deadline')),{once:true}))]);
      await page.getByRole('button',{name:'제출',exact:true}).click(); const serverResponse=await bounded(reached.promise); assert.equal(serverResponse.status,200);
      await page.locator('.workspace-picker__button').click();
      const denied=captureJsonResponse(page,r=>new URL(r.url()).pathname==='/api/v1'+base+'/'+cas.id && r.request().headers()['x-org-id']===otherCompany.org_id,result);
      await page.getByRole('menuitemradio',{name:/T23_SWITCH_B/}).click(); assert.equal((await denied).response.status(),404);
      release.resolve(); await bounded(settled.promise); await rendered(page,'main [role="alert"]');
      assert.equal(await page.locator('[data-approval-editor]').count(),0);
      const original=await request(owner,base+'/'+cas.id); assert.equal(original.status,'draft'); assert.equal(original.body.purpose,'Old company staged submit');
      assert.ok(!result.http.some(row=>row.origin==='Chrome' && row.route==='/api/v1'+base+'/'+cas.id+'/submit'));
      result.scopeGate={oldCompany:owner.orgId,newCompany:otherCompany.org_id,oldRequest:cas.id,serverSave:200,newScopeRead:404,oldRequestRemainsDraft:true};
    } finally { release.resolve(); await context.unroute(gatePath); }
    // 다른 탭에서 재로그인된 인증 세션을 받는 storage 경계도 회사 ID가 같을 때 별도로 검증한다.
    const actorScope=await surface(owner), authTab2=await actorScope.context.newPage();
    const readReached=Promise.withResolvers(), readRelease=Promise.withResolvers(), readSettled=Promise.withResolvers();
    const readPath='**/api/v1'+base+'/'+cas.id;
    try {
      await authTab2.goto(origin+'/login');
      await actorScope.context.route(readPath,async route=>{
        if(route.request().headers().authorization!==`Bearer ${owner.token}`) return route.continue();
        try { const response=await route.fetch(); const body=await response.body(); readReached.resolve(response.status()); await readRelease.promise; await route.fulfill({response,body}); readSettled.resolve(); }
        catch(error) { readSettled.reject(error); }
      });
      const signal=AbortSignal.timeout(15000);
      const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('Identity gate deadline')),{once:true}))]);
      await actorScope.page.goto(url(cas.id)); assert.equal(await bounded(readReached.promise),200);
      const denied=captureJsonResponse(actorScope.page,r=>new URL(r.url()).pathname==='/api/v1'+base+'/'+cas.id && r.request().headers().authorization===`Bearer ${other.token}`,result);
      await changeStorage(actorScope.page,()=>authTab2.evaluate(session=>localStorage.setItem('orbitflow.session.v1',JSON.stringify(session)),other.session));
      assert.equal((await denied).response.status(),404); readRelease.resolve(); await bounded(readSettled.promise); await rendered(actorScope.page,'main [role="alert"]');
      assert.equal(await actorScope.page.locator('[data-approval-editor]').count(),0);
      result.identityGate={company:owner.orgId,oldActor:owner.id,newActor:other.id,oldRead:200,newRead:404,staleEditorAbsent:true};
    } finally { readRelease.resolve(); await actorScope.context.unroute(readPath); await actorScope.context.close(); }
  }
  await writeFile(path.join(attempt,store+'-extended.json'),JSON.stringify(result.extended.at(-1),null,2));
}
