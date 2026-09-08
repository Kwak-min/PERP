import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, createOwnerOrg } from './http.js';

// 23의 두 읽기 확장만 검증한다. 기존 구성원 권한/결재 읽기 predicate는 그대로다.
test('approval requester candidates remain minimal, company-scoped and action-authorized; list pages remain private', async () => {
  const server = await startTestServer();
  try {
    const owner = await createOwnerOrg(server.baseUrl,['approvals']);
    const foreign = await createOwnerOrg(server.baseUrl,['approvals']);
    const request = async (actor, route, method = 'GET', body, expected = 200) => {
      const result = await api(server.baseUrl,route,{ ...actor, method, body }); assert.equal(result.status,expected,JSON.stringify(result.body)); return result.body;
    };
    const requesterRole = await request(owner,'/settings/roles','POST',{name:'Approval requester only',scope:'self',permissions:['approval.request','menu.approvals']},201);
    const invite = await request(owner,'/members/invites','POST',{email:'requester@example.invalid',roles:[requesterRole.key]},201);
    const signup = await request(null,'/auth/signup','POST',{name:'Owner',email:'requester@example.invalid',password:'password-1234',invitation_token:invite.token},201);
    const requester={token:signup.access_token,orgId:owner.orgId,userId:signup.user.id};
    await request(requester,'/members','GET',undefined,403);
    const candidates = await request(requester,'/approvals/approver-candidates');
    assert.deepEqual(candidates.items.map(row => Object.keys(row).sort()),candidates.items.map(() => ['id','name']));
    assert.ok(candidates.items.some(row => row.id === owner.userId));
    assert.ok(!candidates.items.some(row => [foreign.userId,requester.userId].includes(row.id)));
    const draftIds=[];
    for(let index=0;index<27;index++) draftIds.push((await request(requester,'/approvals/drafts','POST',{title:'Page '+index,body:{purpose:'Test'},steps:[{approver_id:owner.userId}]},201)).id);
    const first=await request(requester,'/approvals/requests?box=drafts&limit=25&offset=0');
    const next=await request(requester,'/approvals/requests?box=drafts&limit=25&offset=25');
    assert.equal(first.items.length,25); assert.equal(first.has_more,true); assert.equal(next.items.length,2); assert.equal(next.has_more,false);
    assert.deepEqual(new Set([...first.items,...next.items].map(row=>row.id)),new Set(draftIds));
    for(const actor of [owner,foreign]) {
      assert.deepEqual((await request(actor,'/approvals/requests?box=drafts')).items,[]);
      await request(actor,'/approvals/requests/'+draftIds[0],'GET',undefined,404);
      await request(actor,'/approvals/requests/'+draftIds[0]+'/history','GET',undefined,404);
    }
    const current=await request(requester,'/approvals/requests/'+draftIds[0]);
    const submitted=await request(requester,'/approvals/requests/'+current.id+'/submit','POST',{expected_version:current.version,form_revision:1});
    assert.ok((await request(owner,'/approvals/requests?box=inbox')).items.some(row=>row.id===submitted.id));
    assert.equal((await request(owner,'/approvals/requests?box=inbox')).items.length,1);
    await request(requester,'/approvals/requests?box=drafts&offset=-1','GET',undefined,400);
  } finally { await server.close(); }
});
