import assert from 'node:assert/strict';
import sharp from 'sharp';
import { dom, downloadedBytes } from './deadline-expense-actions.mjs';
import { fixtureFetch } from './insecure-origin.mjs';

export async function receiptRetry({ page, apiPrefix, actor, request, id, capture }) {
  const detail = page.locator(`[data-expense-detail="${id}"]`);
  const before = await request(actor, `/finance/transactions/${id}`);
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#def' } }).png().toBuffer();
  const uploadPattern = '**' + apiPrefix + '/transactions/receipt-uploads';
  const rejectUpload = route => route.abort('failed');
  await page.route(uploadPattern, rejectUpload);
  try {
    const failed = dom(page, '[data-expense-detail] [data-upload-state="failed"]');
    await detail.locator('[name="receipts"]').setInputFiles({ name: 'retry-receipt.png', mimeType: 'image/png', buffer: png }); await failed;
  } finally { await page.unroute(uploadPattern, rejectUpload); }
  const uploaded = dom(page, '[data-expense-detail] [data-upload-state="ready"]');
  await detail.getByRole('button', { name: '업로드 재시도', exact: true }).click(); await uploaded;
  assert.equal(await detail.locator('.expense-receipts li').count(), 1);
  const pattern = '**' + apiPrefix + `/transactions/${id}/receipts`, attempts = [];
  const interrupt = async route => {
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    const response = await fixtureFetch(route); assert.equal(response.status(), 200);
    if (attempts.length === 1) await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    else await route.fulfill({ response });
  };
  await page.route(pattern, interrupt);
  try {
    const failed = dom(page, '[data-expense-detail] [role="alert"]');
    await detail.locator('[data-append-receipts]').click(); await failed;
    assert.equal((await request(actor, `/finance/transactions/${id}`)).receipts.length, 2);
    await capture('receipt-append-uncertain');
    const saved = dom(page, '[data-expense-detail] .expense-files li:nth-child(2)');
    await detail.locator('[data-append-receipts]').click(); await saved;
  } finally { await page.unroute(pattern, interrupt); }
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  const after = await request(actor, `/finance/transactions/${id}`);
  assert.equal(after.receipts.length, 2); assert.equal(after.amount, before.amount);
  assert.equal(after.version, before.version); assert.deepEqual(after.lines, before.lines);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dom(page, '[data-expense-detail] .expense-files li:nth-child(2)');
  const receipt = after.receipts.find(item => item.filename === 'retry-receipt.png'); assert.ok(receipt);
  const download = page.waitForEvent('download', { timeout: 10000 });
  await page.locator(`[data-receipt-download="${receipt.file_id}"]`).click();
  assert.deepEqual(await downloadedBytes(await download), png);
  return { stableKey: attempts[0].key === attempts[1].key, attempts, receipts: after.receipts.length, amount: after.amount };
}
