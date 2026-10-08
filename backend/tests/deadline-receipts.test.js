import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { startDeadlineServer, evidenceBody } from './deadline-fixture.js';
import { createOwnerOrg } from './http.js';

const evidence = new URL('../../.omo/evidence/task-16-deadline-erp-redesign/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('receipt boundary: authenticated HTTP, real decoding, transactional consumption and stage-only cleanup', async t => {
  await mkdir(evidence, { recursive: true });
  process.env.ORBITFLOW_UPLOAD_DIR = path.join(process.env.DEADLINE_TEMP_ROOT, 'receipts');
  const server = await startDeadlineServer();
  const scenarios = [];
  try {
    const { db, transaction } = await import('../src/config/db.js');
    const { resolvePrincipal } = await import('../src/middleware/auth.js');
    const service = await import('../src/services/legacy-receipt-files.service.js');
    const { validateReceipt, receiptPath } = await import('../src/services/receipt-files.service.js');
    const { insert } = await import('../src/models/base.js');
    const actor = await createOwnerOrg(server.baseUrl, ['finance', 'approvals']);
    const foreign = await createOwnerOrg(server.baseUrl, ['finance', 'approvals']);
    const actorPrincipal = () => resolvePrincipal({ get: name => ({ authorization: `Bearer ${actor.token}`, 'x-org-id': actor.orgId })[name] });
    const principal = actorPrincipal();
    const invited = await server.request(actor, '/members/invites', 'POST', { email: 'receipt-peer@example.invalid', roles: ['company_admin'] }, 201);
    const signup = await server.request(null, '/auth/signup', 'POST', { name: 'Receipt peer', email: 'receipt-peer@example.invalid', password: 'password-1234', invitation_token: invited.token }, 201);
    const peer = { token: signup.access_token, orgId: actor.orgId, userId: signup.user.id };
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } }).png().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const document = await PDFDocument.create(); document.addPage();
    const pdf = Buffer.from(await document.save());
    document.context.trailerInfo.Encrypt = document.context.register(document.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2, P: -4,
      O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('11'.repeat(32)) }));
    const encrypted = Buffer.from(await document.save());
    async function upload(bytes = png, options = {}) {
      const who = options.actor === undefined ? actor : options.actor;
      const route = options.route ?? '/finance/transactions/receipt-uploads';
      const response = await fetch(server.baseUrl + route, { method: 'POST', headers: {
        ...(who ? { Authorization: `Bearer ${who.token}`, 'X-Org-Id': who.orgId } : {}),
        'Content-Type': options.mime ?? 'image/png', 'X-Upload-Name': options.encoded ?? encodeURIComponent(options.filename ?? '영수증.png'),
      }, body: bytes, signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      scenarios.push({ route, status: response.status, code: body.error?.code, size: bytes.length, hash: hash(bytes) });
      assert.equal(response.status, options.status ?? 201, JSON.stringify(evidenceBody(body)));
      return body;
    }
    async function parent() {
      return server.request(actor, '/finance/transactions', 'POST', { kind: 'expense', amount_minor: 100, occurred_on: '2026-09-08' }, 201);
    }
    const consume = (p, tokens, overrides = {}) => transaction(() => service.consumeLegacyReceipts(principal, { kind: 'transaction', parentId: p.id, expectedVersion: p.version, tokens, ...overrides }))();
    let uploaded, attached, tx;
    await t.test('authenticated receipt upload returns an opaque scoped token rather than adopting a path', async () => {
      uploaded = await upload();
      assert.match(uploaded.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(uploaded.filename, '영수증.png'); assert.equal(uploaded.size_bytes, png.length);
      assert.equal(uploaded.file_id, undefined); assert.equal(uploaded.storage_key, undefined); assert.equal(uploaded.checksum_sha256, hash(png));
      const row = db().prepare('SELECT * FROM receipt_upload WHERE token_hash=?').get(hash(uploaded.token));
      assert.equal(new Date(row.expires_at) - new Date(row.created_at), 86400000);
      assert.equal(row.source, 'legacy'); assert.equal(row.actor_id, actor.userId); assert.equal(row.org_id, actor.orgId);
      assert.match(row.storage_key, /^receipts\/[0-9a-f-]+\.png$/); assert.equal(row.token, undefined);
    });
    await t.test('valid JPEG and parsed PDF preserve the exact bytes', async () => {
      for (const [bytes, filename, mime] of [[jpeg, 'a.jpg', 'image/jpeg'], [pdf, 'a.pdf', 'application/pdf']]) {
        const result = await upload(bytes, { filename, mime }); assert.equal(result.checksum_sha256, hash(bytes));
      }
    });
    await t.test('spoofing, SVG, traversal, malformed headers, encrypted PDF and arbitrary adoption are rejected', async () => {
      for (const [bytes, options] of [
        [png, { mime: 'image/jpeg' }], [png, { filename: 'a.jpg', mime: 'image/jpeg' }],
        [Buffer.from('<svg/>'), { filename: 'a.svg', mime: 'image/svg+xml' }], [png, { filename: '../a.png' }], [png, { filename: 'C:\\a.png' }],
        [png, { encoded: '%FF' }], [png, { filename: 'bad\n.png' }], [png.subarray(0, 45), {}], [Buffer.alloc(0), {}],
        [encrypted, { filename: 'locked.pdf', mime: 'application/pdf' }], [Buffer.from('%PDF-1.7\ninvalid'), { filename: 'a.pdf', mime: 'application/pdf' }],
        [Buffer.from(JSON.stringify({ file_id: '1', path: 'outside', url: 'https://example.invalid/a.png' })), { mime: 'application/json' }],
      ]) await upload(bytes, { ...options, status: 400 });
      await upload(png, { route: '/finance/transactions/receipt-uploads?file_id=1', status: 400 });
      await upload(png, { actor: null, status: 401 });
    });
    await t.test('decoder caps pixels rather than trusting the signature or metadata', async () => {
      const oversized = await sharp({ create: { width: 8000, height: 5001, channels: 3, background: '#fff' } }).png().toBuffer();
      await upload(oversized, { status: 400 });
      const exact = await sharp({ create: { width: 8000, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
      await upload(exact);
      const entropy = Buffer.from(Array.from({ length: 96 * 96 * 3 }, (_, i) => (i * 73 + Math.floor(i / 17) * 31) % 256));
      const detailedJpeg = await sharp(entropy, { raw: { width: 96, height: 96, channels: 3 } }).jpeg().toBuffer();
      const truncated = detailedJpeg.subarray(0, detailedJpeg.length - 64);
      assert.equal((await sharp(truncated, { failOn: 'warning' }).metadata()).width, 96);
      await upload(truncated, { filename: 'truncated.jpg', mime: 'image/jpeg', status: 400 });
      const damaged = Buffer.from(png); damaged.fill(0, 45, damaged.length - 12);
      await assert.rejects(validateReceipt({ bytes: damaged, filename: 'a.png', mime: 'image/png' }), { code: 'VALIDATION_ERROR' });
    });
    await t.test('10MiB is accepted and 10MiB plus one is HTTP 413', async () => {
      const exact = Buffer.concat([png, Buffer.alloc(10 * 1024 ** 2 - png.length)]);
      await upload(exact); await upload(Buffer.concat([exact, Buffer.of(0)]), { status: 413 });
    });
    await t.test('foreign actor/company/kind, expired, malformed and stale tokens have no writes', async () => {
      tx = await parent();
      const other = await upload(png, { actor: foreign }), peerUpload = await upload(png, { actor: peer });
      const approvalUpload = await upload(png, { route: '/approvals/receipt-uploads' });
      const expired = await upload();
      db().prepare("UPDATE receipt_upload SET expires_at='2000-01-01T00:00:00Z' WHERE token_hash=?").run(hash(expired.token));
      for (const token of [other.token, peerUpload.token, approvalUpload.token, expired.token]) assert.throws(() => consume(tx, [token]), { code: 'NOT_FOUND' });
      assert.throws(() => consume(tx, [uploaded.token], { expectedVersion: -1 }), { code: 'VERSION_CONFLICT' });
      assert.throws(() => consume(tx, ['https://example.invalid/a.png']), { name: 'ZodError' });
      assert.throws(() => consume(tx, [uploaded.token, uploaded.token]), { name: 'ZodError' });
      assert.equal(db().prepare('SELECT COUNT(*) AS n FROM transaction_evidence').get().n, 0);
    });
    await t.test('consume atomically links, audits and preserves originals through relogin download', async () => {
      attached = consume(tx, [uploaded.token])[0];
      assert.throws(() => consume(tx, [uploaded.token]), { code: 'NOT_FOUND' });
      const login = await server.request(null, '/auth/login', 'POST', { email: db().prepare('SELECT email FROM app_user WHERE id=?').get(actor.userId).email, password: 'password-1234' });
      const route = `/finance/transactions/${tx.id}/receipts/${attached.file_id}`;
      const response = await fetch(server.baseUrl + route, { headers: { Authorization: `Bearer ${login.access_token}`, 'X-Org-Id': actor.orgId }, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(png));
      assert.match(response.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      await server.request(foreign, route, 'GET', undefined, 404);
      const wrongParent = await parent(); await server.request(actor, `/finance/transactions/${wrongParent.id}/receipts/${attached.file_id}`, 'GET', undefined, 404);
      assert.throws(() => db().prepare('DELETE FROM transaction_evidence WHERE file_id=?').run(attached.file_id), /immutable/);
      assert.throws(() => db().prepare('UPDATE file_object SET filename=? WHERE id=?').run('changed.png', attached.file_id), /immutable/);
      scenarios.push({ download: route, status: 200, sha256: hash(png), authenticatedRelogin: true });
    });
    await t.test('failure after link creation rolls back files, link, audit and token consumption', async () => {
      const rollbackUpload = await upload(), p = await parent();
      db().exec("CREATE TRIGGER fail_receipt_audit BEFORE INSERT ON audit_event WHEN NEW.action='receipt.attached' BEGIN SELECT RAISE(ABORT,'injected receipt audit failure'); END");
      try { assert.throws(() => consume(p, [rollbackUpload.token]), /injected receipt audit failure/); }
      finally { db().exec('DROP TRIGGER fail_receipt_audit'); }
      assert.equal(db().prepare('SELECT state FROM receipt_upload WHERE token_hash=?').get(hash(rollbackUpload.token)).state, 'ready');
      assert.equal(db().prepare('SELECT COUNT(*) AS n FROM transaction_evidence WHERE transaction_id=?').get(p.id).n, 0);
      assert.equal(consume(p, [rollbackUpload.token]).length, 1);
    });
    await t.test('five files and exactly 25MiB attach; a sixth or aggregate overflow rolls back', async () => {
      const padded = Buffer.concat([png, Buffer.alloc(5 * 1024 ** 2 - png.length)]), uploads = [];
      for (let i = 0; i < 6; i++) uploads.push(await upload(padded));
      const p = await parent(); assert.throws(() => consume(p, uploads.map(row => row.token)), { name: 'ZodError' });
      assert.equal(consume(p, uploads.slice(0, 5).map(row => row.token)).length, 5);
      assert.throws(() => consume(p, [uploads[5].token]), { code: 'VALIDATION_ERROR' });
      const over = await parent(), large = [];
      for (let i = 0; i < 3; i++) large.push(await upload(Buffer.concat([png, Buffer.alloc(9 * 1024 ** 2 - png.length)])));
      assert.throws(() => consume(over, large.map(row => row.token)), { code: 'VALIDATION_ERROR' });
    });
    // Recreate pre-migration links: neither org_id nor receipt_upload_id was present.
    async function oldEvidence(p, sizes, fileScope = principal, linkScope = {}) {
      const originals = [];
      await mkdir(process.env.ORBITFLOW_UPLOAD_DIR, { recursive: true });
      for (const size of sizes) {
        const bytes = Buffer.concat([png, Buffer.alloc(size - png.length)]);
        const key = `old-${randomUUID()}.png`;
        await writeFile(path.join(process.env.ORBITFLOW_UPLOAD_DIR, key), bytes);
        const file = insert('file_object', { tenant_id: fileScope.tenantId, org_id: fileScope.orgId, storage_key: key,
          filename: key, mime: 'image/png', size, checksum: hash(bytes), created_by: fileScope.userId });
        const link = insert('transaction_evidence', { tenant_id: principal.tenantId, transaction_id: p.id,
          file_id: file.id, created_by: principal.userId, ...linkScope });
        originals.push({ file, link });
      }
      return originals;
    }
    async function assertOldOriginals(originals) {
      for (const { file, link } of originals) {
        assert.deepEqual(db().prepare('SELECT * FROM file_object WHERE id=?').get(file.id), file);
        assert.deepEqual(db().prepare('SELECT * FROM transaction_evidence WHERE id=?').get(link.id), link);
        assert.equal(hash(await readFile(path.join(process.env.ORBITFLOW_UPLOAD_DIR, file.storage_key))), file.checksum);
      }
    }
    for (const [label, sizes, newSize] of [
      ['exact reported five 5MiB originals plus sixth 96-byte PNG', Array(5).fill(5 * 1024 ** 2), 96],
      ['count alone with five 96-byte originals', Array(5).fill(96), 96],
      ['aggregate alone with three 8MiB originals plus 1MiB and 96 bytes', Array(3).fill(8 * 1024 ** 2), 1024 ** 2 + 96],
    ]) await t.test(`nullable legacy evidence rejects ${label} without changing originals or consuming token`, async () => {
      assert.equal(png.length, 96);
      const p = await parent(), originals = await oldEvidence(p, sizes);
      for (const { link } of originals) { assert.equal(link.org_id, null); assert.equal(link.receipt_upload_id, null); }
      const staged = await upload(Buffer.concat([png, Buffer.alloc(newSize - png.length)]));
      const before = db().prepare('SELECT COUNT(*) AS count, SUM(f.size) AS bytes FROM transaction_evidence l JOIN file_object f ON f.id=l.file_id WHERE l.transaction_id=?').get(p.id);
      assert.equal(before.count, sizes.length); assert.equal(before.bytes, sizes.reduce((sum, size) => sum + size, 0));
      assert.throws(() => consume(p, [staged.token]), { code: 'VALIDATION_ERROR' });
      assert.deepEqual(db().prepare('SELECT COUNT(*) AS count, SUM(f.size) AS bytes FROM transaction_evidence l JOIN file_object f ON f.id=l.file_id WHERE l.transaction_id=?').get(p.id), before);
      assert.equal(db().prepare('SELECT state FROM receipt_upload WHERE token_hash=?').get(hash(staged.token)).state, 'ready');
      await assertOldOriginals(originals);
      scenarios.push({ legacyNullOrg: label, before, newBytes: newSize, rejected: true, originalsPreserved: true });
    });
    await t.test('nullable legacy originals allow exact aggregate boundary and remain outside staging cleanup', async () => {
      const p = await parent(), originals = await oldEvidence(p, Array(3).fill(8 * 1024 ** 2));
      const staged = await upload(Buffer.concat([png, Buffer.alloc(1024 ** 2 - png.length)]));
      assert.equal(consume(p, [staged.token]).length, 1);
      const total = db().prepare('SELECT COUNT(*) AS count, SUM(f.size) AS bytes FROM transaction_evidence l JOIN file_object f ON f.id=l.file_id WHERE l.transaction_id=?').get(p.id);
      assert.equal(total.count, 4); assert.equal(total.bytes, 25 * 1024 ** 2);
      service.cleanupLegacyReceipts();
      await assertOldOriginals(originals);
    });
    await t.test('legacy counting uses authorized parent and tenant/company files, never adopting foreign associations', async () => {
      const p = await parent();
      const foreignPrincipal = resolvePrincipal({ get: name => ({ authorization: `Bearer ${foreign.token}`, 'x-org-id': foreign.orgId })[name] });
      const otherOrgId = insert('organization', { tenant_id: principal.tenantId, name: 'Other receipt company', modules: 'finance' }).id;
      const originals = [
        ...await oldEvidence(p, [25 * 1024 ** 2], foreignPrincipal),
        ...await oldEvidence(p, [25 * 1024 ** 2], { ...principal, orgId: otherOrgId }),
        ...await oldEvidence(p, [25 * 1024 ** 2], principal, { org_id: otherOrgId }),
        ...await oldEvidence(p, [25 * 1024 ** 2], { ...principal, tenantId: foreignPrincipal.tenantId }),
        ...await oldEvidence(p, [25 * 1024 ** 2], principal, { tenant_id: foreignPrincipal.tenantId }),
      ];
      const staged = await upload();
      // Invalid historic associations must not acquire download authorization or fill this company's quota.
      for (const { file } of originals) await server.request(actor, `/finance/transactions/${p.id}/receipts/${file.id}`, 'GET', undefined, 404);
      assert.throws(() => transaction(() => service.consumeLegacyReceipts(foreignPrincipal, { kind: 'transaction', parentId: p.id, expectedVersion: p.version, tokens: [] }))(), { code: 'NOT_FOUND' });
      assert.equal(consume(p, [staged.token]).length, 1);
      await assertOldOriginals(originals);
    });
    await t.test('approval attachments inherit requester/assigned-reader boundaries and terminal immutability', async () => {
      const request = await server.request(actor, '/approvals/requests', 'POST', { title: 'Receipt approval', steps: [{ approver_id: actor.userId }] }, 201);
      const staged = await upload(png, { route: '/approvals/receipt-uploads' });
      const version = db().prepare('SELECT version FROM approval WHERE id=?').get(request.id).version;
      const [file] = consume(request, [staged.token], { kind: 'approval', expectedVersion: version });
      await server.request(peer, `/approvals/requests/${request.id}/receipts/${file.file_id}`, 'GET', undefined, 404);
      db().prepare("UPDATE approval SET status='approved' WHERE id=?").run(request.id);
      const extra = await upload(png, { route: '/approvals/receipt-uploads' });
      assert.throws(() => consume(request, [extra.token], { kind: 'approval', expectedVersion: version }), { code: 'CONFLICT' });
      assert.throws(() => db().prepare('DELETE FROM approval_receipt_files WHERE file_id=?').run(file.file_id), /immutable/);
    });
    await t.test('revoked permission outranks a stale version even for an already-resolved principal', async () => {
      const staged = await upload(), p = await parent();
      const membership = db().prepare('SELECT * FROM membership WHERE user_id=? AND org_id=?').get(actor.userId, actor.orgId);
      db().prepare("UPDATE membership SET roles='' WHERE id=?").run(membership.id);
      try { assert.throws(() => consume(p, [staged.token], { expectedVersion: -1 }), { code: 'PERMISSION_DENIED' }); }
      finally { db().prepare('UPDATE membership SET roles=? WHERE id=?').run(membership.roles, membership.id); }
    });
    await t.test('interrupted raw HTTP cannot create a successful upload or an adopted object', async () => {
      const { createApp } = await import('../src/app.js');
      const interrupted = createServer(createApp());
      const listening = once(interrupted, 'listening', { signal: AbortSignal.timeout(10000) });
      interrupted.listen(0, '127.0.0.1'); await listening;
      const before = db().prepare('SELECT COUNT(*) AS n FROM receipt_upload').get().n;
      try {
        const received = once(interrupted, 'request', { signal: AbortSignal.timeout(10000) });
        const client = httpRequest(`http://127.0.0.1:${interrupted.address().port}/api/v1/finance/transactions/receipt-uploads`, { method: 'POST', headers: {
          Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'image/png', 'Content-Length': png.length,
          'X-Upload-Name': 'interrupted.png' } });
        const failed = once(client, 'error', { signal: AbortSignal.timeout(10000) });
        client.flushHeaders();
        const [incoming] = await received;
        const aborted = once(incoming, 'aborted', { signal: AbortSignal.timeout(10000) });
        client.destroy(); await aborted;
        assert.equal((await failed)[0].code, 'ECONNRESET');
        assert.equal(db().prepare('SELECT COUNT(*) AS n FROM receipt_upload').get().n, before);
      } finally { await new Promise((resolve, reject) => interrupted.close(error => error ? reject(error) : resolve())); }
    });
    await t.test('filesystem write failure leaves a retryable owned stage instead of a success token', async () => {
      const originalRoot = process.env.ORBITFLOW_UPLOAD_DIR;
      const blockedRoot = path.join(process.env.DEADLINE_TEMP_ROOT, 'blocked-upload-root');
      await writeFile(blockedRoot, 'not a directory');
      const validated = await validateReceipt({ bytes: png, filename: 'failed.png', mime: 'image/png' });
      process.env.ORBITFLOW_UPLOAD_DIR = blockedRoot;
      try { assert.throws(() => service.stageLegacyReceipt(principal, 'transaction', validated), error => ['ENOTDIR', 'EEXIST'].includes(error.code)); }
      finally { process.env.ORBITFLOW_UPLOAD_DIR = originalRoot; }
      const row = db().prepare("SELECT * FROM receipt_upload WHERE filename='failed.png'").get();
      assert.equal(row.state, 'writing'); assert.equal(row.cleanup_error, 'UPLOAD_WRITE_FAILED'); assert.equal(row.consumed_file_id, null);
    });
    await t.test('a suspended upload cannot resurrect an expired stage', async () => {
      db().exec("CREATE TRIGGER expire_new_receipt AFTER INSERT ON receipt_upload WHEN NEW.filename='expired.png' BEGIN UPDATE receipt_upload SET expires_at='2000-01-01T00:00:00Z' WHERE id=NEW.id; END");
      try { await upload(png, { filename: 'expired.png', status: 404 }); }
      finally { db().exec('DROP TRIGGER expire_new_receipt'); }
      const row = db().prepare("SELECT * FROM receipt_upload WHERE filename='expired.png'").get();
      assert.equal(row.state, 'writing'); assert.equal(existsSync(receiptPath(row.storage_key)), false);
    });
    await t.test('cleanup preserves consumed and shared files and retries only its own failed unconsumed stage', async () => {
      const clean = await upload(), shared = await upload(), broken = await upload();
      const stage = token => db().prepare('SELECT * FROM receipt_upload WHERE token_hash=?').get(hash(token));
      const sharedRow = stage(shared.token), brokenRow = stage(broken.token);
      insert('file_object', { tenant_id: principal.tenantId, org_id: principal.orgId, filename: 'shared.png', storage_key: sharedRow.storage_key });
      const unrelated = path.join(process.env.ORBITFLOW_UPLOAD_DIR, 'other-document.txt'); await writeFile(unrelated, 'preserve');
      db().prepare("UPDATE receipt_upload SET expires_at='2000-01-01T00:00:00Z'").run();
      await rm(receiptPath(brokenRow.storage_key)); await mkdir(receiptPath(brokenRow.storage_key)); await writeFile(path.join(receiptPath(brokenRow.storage_key), 'child'), 'interrupted');
      const result = service.cleanupLegacyReceipts();
      assert.ok(result.deleted > 0); assert.equal(result.shared, 1); assert.equal(result.failed, 1);
      assert.equal(stage(clean.token).state, 'deleted'); assert.equal(stage(uploaded.token).state, 'consumed');
      assert.equal(hash(await readFile(receiptPath(stage(uploaded.token).storage_key))), hash(png));
      assert.equal(await readFile(unrelated, 'utf8'), 'preserve'); assert.ok(existsSync(receiptPath(sharedRow.storage_key)));
      assert.match(stage(broken.token).cleanup_error, /^UNLINK_FAILED:/);
      await rm(receiptPath(brokenRow.storage_key), { recursive: true }); assert.equal(service.cleanupLegacyReceipts().failed, 0);
      assert.equal(stage(broken.token).state, 'deleted');
    });
  } finally {
    await server.close();
    await writeFile(new URL('cleanup.json', evidence), JSON.stringify(server.resource, null, 2));
    await writeFile(new URL('scenario.json', evidence), JSON.stringify(scenarios, null, 2));
  }
});
