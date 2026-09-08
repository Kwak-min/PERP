import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

export function dom(page, selector) {
  return page.evaluate(selector => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(Error(`DOM event deadline: ${selector}`)); }, 15000);
    function check() { if (document.querySelector(selector)) { observer.disconnect(); clearTimeout(timeout); resolve(); } }
    const observer = new MutationObserver(check); observer.observe(document.documentElement, { childList: true, attributes: true, subtree: true }); check();
  }), selector);
}
export async function downloadedBytes(download) {
  const stream = await download.createReadStream(); assert.ok(stream);
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
export async function expenseActions({ page, fixture, evidence, result, origin }) {
  const { pg, expense, income, inactive, actor, request, oldIncome, prefix } = fixture;
  const source = pg ? 'pg' : 'legacy', apiPrefix = '/api/v1' + prefix + '/finance';
  const response = suffix => page.waitForResponse(r => new URL(r.url()).pathname === apiPrefix + suffix && r.request().method() === 'POST');
  async function capture(name) {
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      const filename = `${source}-${name}-${width}.png`, viewportFilename = `${source}-${name}-${width}-viewport.png`;
      await page.screenshot({ path: path.join(evidence, filename), fullPage: true, animations: 'disabled' });
      await page.screenshot({ path: path.join(evidence, viewportFilename), fullPage: false, animations: 'disabled' });
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      assert.ok(geometry.width <= geometry.viewport, `${filename}: horizontal overflow ${JSON.stringify(geometry)}`);
      result.screens.push({ source, name, width, filename, viewportFilename, geometry });
    }
  }
  await dom(page, '[data-expense-entry]');
  assert.equal(await page.locator('[data-ledger-count]').getAttribute('data-ledger-count'), '103');
  await dom(page, '.expense-summary');
  assert.deepEqual(await page.locator('.expense-summary dd').allTextContents(), pg ? ['123.45', '103.02', '20.43'] : ['123.45', '0.00', '123.45']);
  await capture('home');
  await page.locator('a[href="/finance/transactions"]').last().click(); await dom(page, '[data-screen-id="FIN-002"] [data-ledger-count]');
  await page.getByLabel('장부 검색').fill('OLD_INCOME_BOUNDARY');
  assert.equal(await page.locator(`[data-transaction-id="${oldIncome.id}"]`).count(), 1);
  const csvSignal = page.waitForEvent('download');
  await page.getByRole('button', { name: '필터 결과 전체 CSV 내보내기', exact: true }).click();
  const csv = (await downloadedBytes(await csvSignal)).toString('utf8'); assert.match(csv, /OLD_INCOME_BOUNDARY/); assert.match(csv, /123\.45/);
  await page.locator(`[data-transaction-id="${oldIncome.id}"] button`).click(); await dom(page, '[data-old-record]');
  assert.equal((await page.locator('[data-detail-account]').innerText()).trim(), income);
  await capture('old-income');
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await page.getByLabel('장부 검색').fill('');
  const entryReady = dom(page, '[data-expense-form] select[name="account_id"] option[value="' + expense + '"]');
  await page.locator('[data-expense-entry]').click(); await entryReady;
  const form = page.locator('[data-expense-form]');
  assert.equal(await form.locator(`select[name="account_id"] option[value="${income}"]`).count(), 0);
  assert.equal(await form.locator(`select[name="account_id"] option[value="${inactive}"]`).count(), 0);
  await form.locator('[name="merchant"]').fill('브라우저 영수증 사용처');
  await form.locator('button[type="submit"]').click(); await dom(page, '[data-expense-form] [role="alert"]');
  assert.equal(await form.locator('[name="merchant"]').inputValue(), '브라우저 영수증 사용처');
  await capture('validation');
  const amount = pg ? '9999999999999999.99' : '90071992547409.91';
  await form.locator('[name="amount"]').fill(amount); await form.locator('[name="expense_date"]').fill('2026-09-08');
  await form.locator('[name="expense_time"]').fill('12:34:56'); await form.locator('[name="account_id"]').selectOption(expense);
  await form.locator('[name="memo"]').fill('LARGE_EXACT_EXPENSE');
  const invalid = response('/transactions/receipt-uploads');
  await form.locator('[name="receipts"]').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  assert.equal((await invalid).status(), 400); await dom(page, '[data-upload-state="failed"]');
  assert.equal(await form.locator('[name="amount"]').inputValue(), amount);
  await capture('upload-failure');
  await form.getByRole('button', { name: '제거', exact: true }).click();
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#4f46e5' } }).png().toBuffer();
  const hash = data => createHash('sha256').update(data).digest('hex');
  let release, arrived;
  const held = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route('**' + apiPrefix + '/transactions/receipt-uploads', async route => { arrived(); await gate; await route.continue(); });
  await form.locator('[name="receipts"]').setInputFiles({ name: '한글 원본.png', mimeType: 'image/png', buffer: png });
  await held; await dom(page, '[data-upload-state="pending"]');
  assert.equal(await form.locator('button[type="submit"]').isDisabled(), true); assert.equal(await page.locator('[data-expense-success]').count(), 0);
  await capture('upload-pending');
  const uploaded = response('/transactions/receipt-uploads'); release(); assert.equal((await uploaded).status(), 201);
  await dom(page, '[data-upload-state="ready"]'); await page.unroute('**' + apiPrefix + '/transactions/receipt-uploads');
  await form.locator('input[type="checkbox"]').check(); await capture('confirm');
  let lose = true; const attempts = []; let committed;
  await page.route('**' + apiPrefix + '/expenses', async route => {
    attempts.push({ key: route.request().headers()['idempotency-key'], payload: route.request().postDataJSON() });
    const saved = await route.fetch();
    if (saved.status() !== 201) { await route.fulfill({ response: saved }); return; }
    committed = await saved.json();
    if (lose) { lose = false; await route.abort('failed'); } else await route.fulfill({ response: saved });
  });
  const lost = dom(page, '[data-expense-form] input[name="amount"]:disabled');
  await form.locator('button[type="submit"]').click(); await lost;
  await dom(page, '[data-expense-form] [role="status"]');
  // 정확한 버튼 enabled 전이는 MutationObserver로 기다린다.
  await dom(page, '[data-expense-form] button[type="submit"]:not(:disabled)');
  assert.equal(await page.locator('[data-expense-success]').count(), 0); assert.equal(await form.locator('[name="amount"]').inputValue(), amount);
  await capture('response-loss');
  const retried = response('/expenses'); await form.locator('button[type="submit"]').click(); assert.equal((await retried).status(), 201);
  await dom(page, '[data-detail-amount]');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]); assert.equal(attempts[0].payload.amount, amount); assert.equal(typeof attempts[0].payload.amount, 'string');
  assert.equal(committed.amount, amount); assert.equal(committed.occurred_at, '2026-09-08T03:34:56.000Z');
  const listed = (await request(actor, '/finance/transactions' + (pg ? '' : '?limit=-1'))).items.find(row => String(row.id ?? row.__id) === committed.id);
  assert.equal(pg ? listed.일자 : listed.expense_date, '2026-09-08');
  await page.unroute('**' + apiPrefix + '/expenses');
  await page.reload({ waitUntil: 'domcontentloaded' }); await dom(page, '[data-detail-amount]');
  assert.ok((await page.locator('[data-detail-amount]').innerText()).includes(amount)); assert.equal((await page.locator('[data-detail-account]').innerText()).trim(), expense);
  assert.equal(await page.locator('main iframe, main embed, main object, main img[src^="blob:"]').count(), 0);
  await page.evaluate(() => { window.receiptUrls = { created: [], revoked: [] }; const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL); URL.createObjectURL = blob => { const url = create(blob); window.receiptUrls.created.push(url); return url; }; URL.revokeObjectURL = url => { window.receiptUrls.revoked.push(url); revoke(url); }; });
  const downloadSignal = page.waitForEvent('download'); await page.locator('[data-receipt-download]').click();
  const download = await downloadSignal, bytes = await downloadedBytes(download);
  assert.equal(download.suggestedFilename(), '한글 원본.png'); assert.equal(hash(bytes), hash(png));
  assert.deepEqual(await page.evaluate(() => window.receiptUrls.created), await page.evaluate(() => window.receiptUrls.revoked));
  const before = await request(actor, `/finance/transactions/${committed.id}`);
  const detail = page.locator('[data-expense-detail]');
  const pdfDocument = await PDFDocument.create(); pdfDocument.addPage(); const pdf = Buffer.from(await pdfDocument.save());
  const appendUpload = response('/transactions/receipt-uploads');
  await detail.locator('[name="receipts"]').setInputFiles({ name: '추가 원본.pdf', mimeType: 'application/pdf', buffer: pdf }); assert.equal((await appendUpload).status(), 201); await dom(page, '[data-upload-state="ready"]');
  const appended = response(`/transactions/${committed.id}/receipts`); await detail.locator('[data-append-receipts]').click(); assert.equal((await appended).status(), 200);
  await dom(page, '[data-expense-detail] .expense-files li:nth-child(2) [data-receipt-download]');
  const after = await request(actor, `/finance/transactions/${committed.id}`);
  assert.equal(after.receipts.length, 2); assert.equal(after.amount, before.amount); assert.deepEqual(after.lines, before.lines); assert.equal(after.version, before.version);
  await page.reload({ waitUntil: 'domcontentloaded' }); await dom(page, '[data-detail-amount]'); assert.equal(await page.locator('[data-receipt-download]').count(), 2);
  const pdfReceipt = after.receipts.find(file => file.mime === 'application/pdf'); assert.ok(pdfReceipt);
  const pdfSignal = page.waitForEvent('download');
  const pdfResponse = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/receipts/' + pdfReceipt.file_id));
  await page.locator(`[data-receipt-download="${pdfReceipt.file_id}"]`).click();
  const pdfDownloaded = await pdfSignal, pdfBytes = await downloadedBytes(pdfDownloaded);
  assert.equal(pdfDownloaded.suggestedFilename(), '추가 원본.pdf'); assert.equal(hash(pdfBytes), hash(pdf));
  assert.match((await pdfResponse).headers()['content-disposition'], /^attachment;/);
  assert.equal(await page.locator('main iframe, main embed, main object, main img[src^="blob:"]').count(), 0);
  await capture('detail');
  await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
  await page.getByLabel('장부 검색').fill('LARGE_EXACT_EXPENSE');
  const exactCsvSignal = page.waitForEvent('download'); await page.getByRole('button', { name: '필터 결과 전체 CSV 내보내기', exact: true }).click();
  assert.ok((await downloadedBytes(await exactCsvSignal)).toString('utf8').includes(amount));
  await page.goto(origin + '/finance', { waitUntil: 'domcontentloaded' }); await dom(page, '.expense-summary');
  assert.deepEqual(await page.locator('.expense-summary dd').allTextContents(), pg ? ['123.45', '10000000000000103.01', '-9999999999999979.56'] : ['123.45', '90071992547409.91', '-90071992547286.46']);
  await capture('large-summary');
  result.cases.push({ source, countBefore: 103, countAfter: (await request(actor, '/finance/transactions' + (pg ? '' : '?limit=-1'))).items.length, oldIncome: oldIncome.id, amount, created: committed.id, beforeHash: hash(png), downloadedHash: hash(bytes), filename: download.suggestedFilename(), pdfBeforeHash: hash(pdf), pdfDownloadedHash: hash(pdfBytes), stableKey: attempts[0].key === attempts[1].key, appended: after.receipts.length });
}
