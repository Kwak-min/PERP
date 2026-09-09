import path from 'node:path';
import { statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const storesAllowed = ['legacy', 'perp_db'];
function invalidConfig() {
  return Object.assign(new Error('Invalid cleanup configuration; check ORBITFLOW_*_CLEANUP_* and explicit DB/upload-root settings.'), { code: 'IMPORT_CLEANUP_CONFIG' });
}
function selectedStores(value = '') {
  const stores = value.trim() ? value.split(',').map(store => store.trim()) : [];
  if (stores.some(store => !storesAllowed.includes(store)) || new Set(stores).size !== stores.length) throw invalidConfig();
  return stores;
}

export function readImportCleanupConfig(source = process.env) {
  const stores = selectedStores(source.ORBITFLOW_IMPORT_CLEANUP_STORES);
  const receiptStores = selectedStores(source.ORBITFLOW_RECEIPT_CLEANUP_STORES);
  const selected = [...stores, ...receiptStores];
  const uploadRoot = (source.ORBITFLOW_UPLOAD_DIR ?? '').trim();
  if (receiptStores.length) {
    // API와 같은 명시 영속 root만 사용한다. 실제 mount/보존 정책은 운영자가 확인한다.
    try { if (!path.isAbsolute(uploadRoot) || !statSync(uploadRoot, { throwIfNoEntry: false })?.isDirectory()) throw invalidConfig(); }
    catch { throw invalidConfig(); }
  }
  const intervalMs = Number(source.ORBITFLOW_IMPORT_CLEANUP_INTERVAL_MS ?? 3600000);
  const timeoutMs = Number(source.ORBITFLOW_IMPORT_CLEANUP_TIMEOUT_MS ?? 30000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 2147483647
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > intervalMs) throw invalidConfig();
  const databaseFile = source.ORBITFLOW_DATABASE_FILE ?? '';
  if (selected.includes('legacy') && !path.isAbsolute(databaseFile)) throw invalidConfig();
  if (selected.includes('perp_db')) {
    if (source.DATABASE_URL) {
      let url;
      try { url = new URL(source.DATABASE_URL); } catch { throw invalidConfig(); }
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.port || !url.username || url.pathname.length < 2) throw invalidConfig();
    } else if (!source.PG_HOST || !source.PG_DATABASE || !source.PG_USER
      || !/^\d+$/.test(source.PG_PORT ?? '') || Number(source.PG_PORT) < 1 || Number(source.PG_PORT) > 65535) throw invalidConfig();
  }
  // 환경을 시작 시 고정한다. 선택하지 않은 저장소는 worker에서도 연결하지 않는다.
  const connectionEnv = Object.fromEntries(['DATABASE_URL', 'PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD'].map(key => [key, source[key] ?? '']));
  return { stores, receiptStores, uploadRoot, intervalMs, timeoutMs, connectionEnv, databaseFile };
}

// SQLite 동기 잠금도 HTTP event loop를 막지 않는다. 종료/상한은 실제 worker exit까지 기다린다.
export function runImportCleanupStore(store, config, signal, { kind = 'imports', timers = globalThis, createWorker = (url, options) => new Worker(url, options) } = {}) {
  if (signal.aborted) return Promise.resolve({ status: 'cancelled' });
  return new Promise(resolve => {
    let worker;
    try {
      worker = createWorker(new URL('./expense-import-cleanup-worker.js', import.meta.url), {
        workerData: { kind, store, timeoutMs: config.timeoutMs },
        env: { ...process.env, ...config.connectionEnv, ORBITFLOW_DATABASE_FILE: config.databaseFile, ORBITFLOW_UPLOAD_DIR: config.uploadRoot, PGOPTIONS: '' },
        stdout: true, stderr: true,
      });
    } catch { resolve({ status: 'failed', reason: 'worker_error' }); return; }
    // 의존성의 오류 stack/SQL/연결 문자열은 운영 로그로 전달하지 않는다.
    worker.stdout?.resume(); worker.stderr?.resume();
    let result, forced;
    const terminate = reason => {
      if (forced) return;
      forced = reason;
      // exit 이벤트가 완료 소유권을 가진다. terminate 거부도 오류 상태로 남긴다.
      worker.terminate().catch(() => { result = { status: 'failed', reason: 'worker_error' }; });
    };
    const abort = () => terminate('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    const deadline = timers.setTimeout(() => terminate('timeout'), config.timeoutMs);
    worker.once('message', message => { result = message; });
    worker.once('error', () => { result = { status: 'failed', reason: 'worker_error' }; });
    worker.once('exit', code => {
      timers.clearTimeout(deadline); signal.removeEventListener('abort', abort);
      if (forced) resolve(forced === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', reason: forced });
      else resolve(code === 0 && result ? result : { status: 'failed', reason: 'worker_error' });
    });
  });
}

export function startImportCleanup(config, { timers = globalThis, runStore = runImportCleanupStore, log = record => console.log(JSON.stringify(record)), now = Date.now } = {}) {
  let stopped = false, running, controller, stopping;
  const jobs = [...config.stores.map(store => ({ kind: 'imports', store })), ...config.receiptStores.map(store => ({ kind: 'receipts', store }))];
  const emit = fields => log({ event: 'expense_import_cleanup', at: new Date(now()).toISOString(), ...fields });
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (running) { emit({ status: 'skipped', reason: 'overlap' }); return Promise.resolve(); }
    controller = new AbortController();
    running = (async () => {
      for (const { kind, store } of jobs) {
        if (stopped) break;
        const started = now();
        emit({ status: 'started', kind, store });
        let result;
        try { result = await runStore(store, config, controller.signal, { kind }); }
        catch { result = { status: 'failed', reason: 'worker_error' }; }
        const fields = { kind, store, duration_ms: Math.max(0, now() - started) };
        // 일부 unlink 실패는 전체 성공으로 숨기지 않고, 완료된 건수와 재시도 사유만 기록한다.
        if (kind === 'receipts' && result.deleted !== undefined) Object.assign(fields, { deleted: result.deleted, failed: result.failed, shared: result.shared });
        if (result.status === 'succeeded') emit({ ...fields, status: 'succeeded', ...(kind === 'imports' ? { deleted: result.deleted, redacted: result.redacted } : {}) });
        else if (result.status === 'cancelled') emit({ ...fields, status: 'cancelled' });
        else emit({ ...fields, status: 'failed', reason: ['busy','timeout','store_unavailable','cleanup_error','worker_error','unlink_failed'].includes(result.reason) ? result.reason : 'cleanup_error', retry: 'next_tick' });
      }
    })().finally(() => { running = undefined; controller = undefined; });
    return running;
  };
  const timer = jobs.length ? timers.setInterval(tick, config.intervalMs) : undefined;
  emit({ status: jobs.length ? 'scheduled' : 'disabled', stores: config.stores, receipt_stores: config.receiptStores, interval_ms: config.intervalMs, timeout_ms: config.timeoutMs });
  return {
    stop() {
      if (stopping) return stopping;
      stopped = true;
      if (timer !== undefined) timers.clearInterval(timer);
      controller?.abort();
      stopping = (async () => { await running; emit({ status: 'stopped' }); })();
      return stopping;
    },
  };
}
