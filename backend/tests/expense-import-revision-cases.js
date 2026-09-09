import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

export function chunkedCommit(url, actor, key, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', signal: AbortSignal.timeout(10000), headers: {
      Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Idempotency-Key': key,
      'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    req.once('error', reject); req.end(body);
  });
}

const header = 'external_id,expense_date,merchant,amount,account_code,memo\n';
const raw = suffix => header + `${suffix},2026-09-08,Selected merchant,17.25,EXP,Selected memo\n`;

// Shared acceptance cases execute against actual authenticated HTTP and native tables on each engine.
export async function transportRegression({ preview, request, snapshot, chunked }) {
  const job = await preview(raw(randomUUID())), key = randomUUID();
  const before = await snapshot(), statuses = [];
  for (const body of [undefined, null, [], { rows: [] }]) statuses.push((await request(job, body, key)).status);
  statuses.push((await chunked(job, key, '')).status);
  const afterInvalid = await snapshot();
  const valid = await request(job, {}, key);
  assert.equal(valid.status, 200);
  const completed = await snapshot();
  for (const body of [undefined, null, [], { extra: true }]) statuses.push((await request(job, body, key)).status);
  statuses.push((await chunked(job, key, '')).status);
  assert.deepEqual((await chunked(job, key, '{}')).body, valid.body);
  assert.deepEqual(await snapshot(), completed, 'invalid replay must not write');
  assert.deepEqual((await request(job, {}, key)).body, valid.body);
  assert.deepEqual(statuses, Array(10).fill(400), 'omitted/null/array/extra bodies must fail before new commit and replay');
  assert.deepEqual(afterInvalid, before, 'invalid initial bodies must not write');
}

export async function retentionRegression({ preview, replace, request, get, expire, cleanup, stored, originals, denyMutation, absentUpload, denyExpiredReplay, cleanupRollback }) {
  const secret = 'SECRET-EXCLUDED-MEMO';
  const source = raw(randomUUID()) + `${randomUUID()},2026-09-08,Private excluded merchant,31.99,EXP,${secret}\n`;
  const superseded = await preview(source, { mapping_confirmed: false });
  const completed = await replace(superseded, { excluded_ordinals: [2] });
  const pending = await preview(raw(randomUUID()));
  const invalid = await preview(raw(randomUUID()), { mapping_confirmed: false });
  const live = await preview(raw(randomUUID())), liveRecord = await stored(live);
  const key = randomUUID(), result = await request(completed, {}, key);
  assert.equal(result.status, 200);
  const postedRows = (await get(completed, '/rows')).body.items;
  const original = await originals();
  // Redaction before expiry, arbitrary edits and result/identity mutation must remain forbidden.
  await denyMutation(completed, false);
  await expire([completed.upload_id, pending.upload_id, invalid.upload_id]);
  await denyMutation(completed, true);
  const beforeCleanup = [];
  for (const job of [superseded, pending, invalid, completed]) {
    beforeCleanup.push(await get(job));
    const page = await get(job, '/rows');
    beforeCleanup.push(page);
  }
  const expiredCommit = await request(pending, {}, randomUUID());
  await cleanupRollback();
  const cleaned = await cleanup();
  assert.deepEqual(beforeCleanup.map(r => r.status), [200,410,200,410,200,410,200,200]);
  for (const response of beforeCleanup) {
    assert.equal(JSON.stringify(response).includes(secret), false, 'expiry is enforced without a scheduler');
    assert.equal(JSON.stringify(response).includes('Selected merchant'), false);
  }
  assert.equal(cleaned.deleted, 3);
  assert.equal(cleaned.redacted, 4);
  for (const job of [superseded, pending, invalid, completed]) {
    assert.equal(await absentUpload(job.upload_id), true);
    const record = await stored(job);
    assert.deepEqual(record.snapshot, record.audit_snapshot);
    assert.equal(JSON.stringify(record).includes(secret), false);
    assert.equal(JSON.stringify(record.snapshot).includes('Selected merchant'), false);
    assert.equal(JSON.stringify(record.snapshot).includes('Selected memo'), false);
    await denyMutation(job, true);
    const summary = await get(job), page = await get(job, '/rows');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.content_expired, true);
    assert.equal(JSON.stringify(summary).includes(secret), false);
    assert.equal(page.status, job === completed ? 200 : 410);
    if (job === completed) {
      assert.deepEqual(page.body.items, postedRows.map(({ logicalRecordOrdinal, disposition, result }) => ({ logicalRecordOrdinal, disposition, result })));
      assert.equal(page.body.content_expired, true);
      assert.equal((await get(job, '/rows?filter=errors')).body.total, 0);
    }
  }
  assert.deepEqual(await stored(live), liveRecord, 'cleanup does not alter active input');
  assert.equal(await absentUpload(live.upload_id), false);
  assert.equal((await get(live)).body.content_expired, false);
  assert.equal(expiredCommit.status, 410, 'expired uncommitted input cannot write');
  await denyExpiredReplay(completed, key);
  assert.deepEqual((await request(completed, {}, key)).body, result.body, 'authorized same-key replay survives physical cleanup');
  assert.equal((await request(completed, {}, randomUUID())).status, 409);
  assert.deepEqual(await originals(), original, 'ledger, receipts, identities, audits and replay are not cleanup targets');
  assert.deepEqual(await cleanup(), { deleted: 0, redacted: 0 });
}
