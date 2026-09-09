import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, statSync } from 'node:fs';

let closeDb, closePgPool, result;
try {
  if ((workerData.kind === 'receipts' && !statSync(process.env.ORBITFLOW_UPLOAD_DIR, { throwIfNoEntry: false })?.isDirectory())
    || (workerData.store === 'legacy' && !existsSync(process.env.ORBITFLOW_DATABASE_FILE))) {
    result = { status: 'failed', reason: 'store_unavailable' };
  } else {
    ({ closeDb } = await import('../config/db.js'));
    const pg = await import('../config/pg.js');
    closePgPool = pg.closePgPool;
    // 전용 worker pool만 제한한다. HTTP pool/서비스의 transaction 계약은 바꾸지 않는다.
    const limits = { connectionTimeoutMillis: Math.min(5000, workerData.timeoutMs),
      statement_timeout: workerData.timeoutMs, lock_timeout: Math.min(5000, workerData.timeoutMs) };
    Object.assign(pg.pgPool.options, limits);
    if (pg.pgPool.options.connectionString) {
      // pg Client는 URL을 다시 우선 병합한다. URL에도 최종 제한을 명시하되 TLS/기타 options는 보존한다.
      // PostgreSQL의 명시 startup GUC는 options(-c ...)보다 우선한다.
      const url = new URL(pg.pgPool.options.connectionString);
      for (const [key, value] of Object.entries(limits)) url.searchParams.set(key, String(value));
      pg.pgPool.options.connectionString = url.href;
    }
    if (workerData.kind === 'receipts') {
      const counts = workerData.store === 'legacy'
        ? (await import('./legacy-receipt-files.service.js')).cleanupLegacyReceipts()
        : await (await import('./pg-receipt-files.service.js')).cleanupPgReceipts();
      result = { status: counts.failed ? 'failed' : 'succeeded', ...(counts.failed ? { reason: 'unlink_failed' } : {}),
        deleted: counts.deleted, failed: counts.failed, shared: counts.shared };
    } else {
      const cleanup = await import('./expense-import.service.js');
      const counts = workerData.store === 'legacy' ? cleanup.cleanupLegacyExpenseImports() : await cleanup.cleanupPgExpenseImports();
      result = { status: 'succeeded', deleted: counts.deleted, redacted: counts.redacted };
    }
  }
} catch (error) {
  const code = error?.code;
  const reason = error?.errcode === 5 || error?.errcode === 6 || code === '55P03' ? 'busy'
    : code === '57014' ? 'timeout' : code === 'SERVICE_UNAVAILABLE' ? 'store_unavailable' : 'cleanup_error';
  result = { status: 'failed', reason };
} finally {
  try { closeDb?.(); await closePgPool?.(); }
  catch { result = { status: 'failed', reason: 'cleanup_error' }; }
}
parentPort.postMessage(result);
