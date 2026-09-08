import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { api, startTestServer } from './http.js';
import { installFinanceFixture } from './pg-daily-finance-fixture.js';

describe('daily finance: real HTTP + isolated PGlite SQL/constraints/transactions', { timeout: 120000 }, () => {
  let server, fixture;
  const request = (route, method='GET', body, key, actor=fixture.actor()) => api(server.baseUrl, '/pg'+route, { ...actor, method, body, headers: key?{'Idempotency-Key':key}:{} });
  const charge = async (amount='100.00') => { const r=await request('/finance/dues','POST',{target_user_id:'2',amount},randomUUID()); assert.equal(r.status,201,JSON.stringify(r.body)); return r.body.id; };
  before(async () => { server=await startTestServer(); fixture=await installFinanceFixture(); });
  after(async () => { await server?.close(); await fixture?.close(); });

  for (const [route, body] of [['/finance/transactions',{account_id:'2',amount:'10.01',memo:'Atomic'}],['/assets',{name:'Atomic asset'}],['/finance/budgets',{name:'Atomic budget',amount:'10.01'}],['/finance/settlements',{title:'Atomic settlement',amount:'10.01'}],['/finance/dues',{target_user_id:'2',amount:'10.01'}]]) {
    it(`${route}: each failed write rolls back; retry/concurrent duplicate commits once; changed payload conflicts`, async () => {
      const key=randomUUID(); fixture.inject();
      const success=await request(route,'POST',body,key);
      assert.equal(success.status,201,JSON.stringify(success.body)); const writeCount=fixture.writes;
      assert.ok(writeCount>=3, 'reservation and response participate in the same transaction');
      for(let i=1;i<=writeCount;i++) {
        const before=await fixture.snapshot(), failedKey=randomUUID(); fixture.inject(i);
        const failed=await request(route,'POST',body,failedKey); assert.equal(failed.status,500,`write ${i}: ${JSON.stringify(failed.body)}`);
        assert.deepEqual(await fixture.snapshot(),before,`write ${i} left partial records`);
        fixture.inject(); const retry=await request(route,'POST',body,failedKey);
        assert.equal(retry.status,201); assert.equal((await request(route,'POST',body,failedKey)).body.id,retry.body.id);
      }
      fixture.inject(); const before=await fixture.snapshot();
      const duplicates=await Promise.all([request(route,'POST',body,key),request(route,'POST',body,key)]);
      assert.deepEqual(duplicates.map(r=>r.body.id),[success.body.id,success.body.id]); assert.deepEqual(await fixture.snapshot(),before);
      assert.equal((await request(route,'POST',{...body,...(body.amount?{amount:'11.01'}:{name:'Changed'})},key)).status,409);
      assert.equal((await request(route,'POST',body)).status,400);
      const freshKey=randomUUID();
      const fresh=await Promise.all([request(route,'POST',body,freshKey),request(route,'POST',body,freshKey)]);
      assert.deepEqual(fresh.map(r=>r.status),[201,201]); assert.equal(fresh[0].body.id,fresh[1].body.id);
      if(route === '/finance/transactions') { const rows=(await fixture.db.query('SELECT SUM(debit)::text AS debit, SUM(credit)::text AS credit FROM accounting.journal_lines WHERE entry_id=$1',[success.body.id])).rows; assert.deepEqual(rows,[{debit:'10.01',credit:'10.01'}]); }
    });
  }

  it('money rejects negative/zero/precision overflow and cross-company accounts', async () => {
    for(const amount of ['-1','0','0.001','10000000000000000','NaN']) {
      for(const [route, extra] of [['transactions',{account_id:'2'}],['budgets',{name:'Budget'}],['settlements',{title:'Settlement'}],['dues',{target_user_id:'2'}]]) {
        assert.equal((await request('/finance/'+route,'POST',{...extra,amount},randomUUID())).status,400,`${route} ${amount}`);
      }
    }
    assert.equal((await request('/finance/transactions','POST',{account_id:'3',amount:'1'},randomUUID())).status,400);
  });

  it('monetary edits require expected version, reject negative, retain audit and protected records', async () => {
    const id=await charge(); const original=await request(`/records/dues/${id}`);
    assert.equal(original.body.version,1);
    assert.equal((await request(`/records/dues/${id}`,'PATCH',{amount:'-1',expected_version:1})).status,400);
    assert.equal((await request(`/records/dues/${id}`,'PATCH',{amount:'90'})).status,400);
    assert.equal((await request(`/records/dues/${id}`,'PATCH',{amount:'90',expected_version:1})).status,200);
    assert.equal((await request(`/records/dues/${id}`,'PATCH',{amount:'80',expected_version:1})).status,409);
    assert.equal((await request(`/records/dues/${id}`)).body.amount,'90.00');
    const audit=(await fixture.db.query("SELECT before_data,after_data FROM accounting.record_events WHERE resource='dues' AND resource_id=$1",[id])).rows;
    assert.equal(audit.length,1); assert.equal(audit[0].before_data.amount,'100.00'); assert.equal(audit[0].after_data.amount,'90.00');
    const entry=await request('/finance/transactions','POST',{account_id:'2',amount:'5'},randomUUID());
    assert.equal((await request(`/records/transactions/${entry.body.id}`,'DELETE',{expected_version:1})).status,409);
    await assert.rejects(fixture.db.query('DELETE FROM accounting.journal_entries WHERE id=$1',[entry.body.id]), /posted|retained/i);
  });

  it('requester reads only own requests; approval decision is audited once and repeat conflicts', async () => {
    const own=await request('/approvals','POST',{request_type:'Expense',note:'Own request'},undefined,fixture.actor(1)); assert.equal(own.status,201);
    await request('/approvals','POST',{request_type:'Private admin request'});
    const ownList=await request('/approvals','GET',undefined,undefined,fixture.actor(1)); assert.equal(ownList.status,200,JSON.stringify(ownList.body));
    assert.deepEqual(ownList.body.items.map(r=>String(r.__id)),[own.body.id]);
    assert.equal((await request(`/approvals/${own.body.id}/decide`,'POST',{decision:'approve'},undefined,fixture.actor(1))).status,403);
    assert.equal((await request(`/approvals/${own.body.id}/decide`,'POST',{decision:'approve'},undefined,fixture.actor(2))).status,404);
    const decisions=await Promise.all([request(`/approvals/${own.body.id}/decide`,'POST',{decision:'approve',comment:'Checked'}),request(`/approvals/${own.body.id}/decide`,'POST',{decision:'reject'})]);
    assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
    assert.equal((await request(`/records/approvals/${own.body.id}`,'DELETE')).status,409);
  });

  it('each payment, correction and approval audit write failure rolls back all state', async () => {
    const id=await charge();
    for (let i=1;i<=5;i++) {
      const key=randomUUID(), before=await fixture.snapshot(); fixture.inject(i);
      const result=await request(`/finance/dues/${id}/payments`,'POST',{amount:'1',expected_version:1},key);
      assert.equal(result.status,500,`payment write ${i}`); assert.deepEqual(await fixture.snapshot(),before);
    }
    fixture.inject();
    for (let i=1;i<=2;i++) {
      const before=await fixture.snapshot(); fixture.inject(i);
      assert.equal((await request(`/records/dues/${id}`,'PATCH',{amount:'90',expected_version:1})).status,500);
      assert.deepEqual(await fixture.snapshot(),before);
    }
    fixture.inject();
    const own=await request('/approvals','POST',{request_type:'Audit rollback'});
    for (let i=1;i<=2;i++) {
      const before=await fixture.snapshot(); fixture.inject(i);
      assert.equal((await request(`/approvals/${own.body.id}/decide`,'POST',{decision:'approve'})).status,500);
      assert.deepEqual(await fixture.snapshot(),before);
    }
    fixture.inject();
  });

  it('partial + remainder payments persist history/outstanding, reject overpay/stale, replay exactly once', async () => {
    const id=await charge('100.01'), key=randomUUID(), body={amount:'40.01',expected_version:1,method:'cash'};
    const first=await request(`/finance/dues/${id}/payments`,'POST',body,key); assert.equal(first.status,201,JSON.stringify(first.body));
    assert.equal((await request(`/finance/dues/${id}/payments`,'POST',body,key)).body.id,first.body.id);
    assert.equal((await request(`/finance/dues/${id}/payments`,'POST',{...body,amount:'40.02'},key)).status,409);
    let history=await request(`/finance/dues/${id}/payments`); assert.equal(history.body.outstanding,'60.00'); assert.equal(history.body.items.length,1); assert.equal(history.body.status,'partial');
    assert.equal((await request(`/finance/dues/${id}/payments`,'POST',{amount:'1',expected_version:1},randomUUID())).status,409);
    assert.equal((await request(`/finance/dues/${id}/payments`,'POST',{amount:'60.01',expected_version:2},randomUUID())).status,400);
    assert.equal((await request(`/records/dues/${id}`,'DELETE',{expected_version:2})).status,409);
    assert.equal((await request(`/records/dues/${id}`,'PATCH',{amount:'1',expected_version:2})).status,409);
    assert.equal((await request(`/finance/dues/${id}/payments`,'POST',{amount:'60.00',expected_version:2},randomUUID())).status,201);
    history=await request(`/finance/dues/${id}/payments`); assert.equal(history.body.outstanding,'0.00'); assert.equal(history.body.items.length,2); assert.equal(history.body.status,'paid');
    assert.equal((await request(`/records/dues/${id}`,'DELETE',{expected_version:3})).status,409);
    await assert.rejects(fixture.db.query('DELETE FROM accounting.dues_charges WHERE id=$1',[id]), /paid|retained/i);
    const foreign=await request(`/finance/dues/${id}/payments`,'GET',undefined,undefined,fixture.actor(2)); assert.equal(foreign.status,404);
  });
});
