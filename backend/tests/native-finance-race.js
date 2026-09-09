import assert from 'node:assert/strict';

const errorDetails = error => ({ name: error.name, message: error.message, code: error.code ?? null,
  severity: error.severity ?? null, detail: error.detail ?? null, where: error.where ?? null,
  stack: error.stack, ...(error.cause ? { cause: errorDetails(error.cause) } : {}) });

// Test-only observer/barrier. Callback acquisitions (authorization queries) are
// never held. Only explicit transaction clients wait, before BEGIN, as before.
export async function competeNative(pool, database, first, second, report = record => console.log(JSON.stringify(record))) {
  const original = pool.connect, pids = [], trace = [], clients = new Map(), active = new Set();
  const gate = Promise.withResolvers(), abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
  let opened = false, failure, timer;
  const record = (phase, fields = {}) => trace.push({ phase, ...fields });
  const fail = error => { failure ??= error; gate.reject(error); };
  // Install rejection handling and every observer before either request starts.
  const barrier = gate.promise.catch(error => { throw error; });
  const barrierSettled = barrier.then(() => null, error => error);
  const state = () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  const driverFailure = (phase, error) => { record(phase, { error: errorDetails(error) }); fail(error); };
  function observe(client) {
    if (clients.has(client)) return;
    const query = client.query; clients.set(client, query);
    client.query = function(sql, ...args) {
      const lock = /FOR (UPDATE|SHARE)/i.test(typeof sql === 'string' ? sql : sql.text);
      if (lock) record('lock-dispatched', { pid: client.processID });
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        const callback = args[last];
        args[last] = function(error, ...values) {
          if (error) driverFailure('query-error', error);
          else if (lock) record('lock-completed', { pid: client.processID });
          return callback.call(this, error, ...values);
        };
      }
      try {
        const result = query.call(this, sql, ...args);
        return result?.then ? result.then(value => {
          if (lock) record('lock-completed', { pid: client.processID });
          return value;
        }, error => { driverFailure('query-error', error); throw error; }) : result;
      } catch (error) { driverFailure('query-error', error); throw error; }
    };
  }
  const onConnect = client => record('new-backend', { pid: client.processID, connectionTimeoutMillis: client._connectionTimeoutMillis });
  const onAcquire = client => { active.add(client); observe(client); record('pool-acquired', { pid: client.processID, ...state() }); };
  const onRelease = (error, client) => { active.delete(client); record('pool-released', { pid: client.processID, error: error ? errorDetails(error) : null }); };
  pool.on('connect', onConnect); pool.on('acquire', onAcquire); pool.on('release', onRelease);
  pool.connect = function(...args) {
    const callback = args[args.length - 1];
    record('acquisition-start', { kind: typeof callback === 'function' ? 'callback' : 'transaction', ...state() });
    if (typeof callback === 'function') {
      args[args.length - 1] = function(error, ...values) {
        if (error) driverFailure('callback-acquisition-error', error);
        return callback.call(this, error, ...values);
      };
      return original.apply(this, args);
    }
    return original.apply(this, args).then(async client => {
      pids.push(client.processID); record('transaction-acquired', { pid: client.processID, ...state() });
      try {
        if (pids.length === 2) {
          // One event-driven snapshot, not lock polling. Both clients are still
          // held before BEGIN; later lock dispatch/completion is observed above.
          const activity = await database.query({ text: `SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
            FROM pg_stat_activity WHERE pid=ANY($1::int[]) ORDER BY pid`, values: [pids], query_timeout: 5000 });
          record('acquisition-barrier', { activity: activity.rows });
          if (!failure) { opened = true; clearTimeout(timer); gate.resolve(); }
        }
        await barrier; return client;
      } catch (error) { fail(error); client.release(); throw error; }
    }, error => { driverFailure('transaction-acquisition-error', error); throw error; });
  };
  timer = setTimeout(() => fail(new Error('two native transaction connections were not acquired')), 10000);
  record('subscribed', { connectionTimeoutMillis: pool.options.connectionTimeoutMillis, barrierTimeoutMillis: 10000,
    requestTimeoutMillis: 15000, ...state() });
  let settled;
  try {
    const requests = [first, second].map((start, index) => Promise.resolve().then(() => start(signal)).then(response => {
      record('request-settled', { index, status: response.status, body: response.body });
      if (!opened) fail(new Error(`Request ${index} settled before both native transaction acquisitions (HTTP ${response.status})`));
      return response;
    }, error => { record('request-rejected', { index, error: errorDetails(error) }); fail(error); throw error; }));
    settled = await Promise.allSettled(requests);
    if (failure) throw failure;
    const rejected = settled.filter(result => result.status === 'rejected');
    if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), 'Native requests failed');
    assert.equal(new Set(pids).size, 2);
    return settled.map(result => result.value);
  } finally {
    clearTimeout(timer); abort.abort();
    // A missing request cannot strand the first checked-out client. On transport
    // failure, disconnect only this race's still-active clients so real PG rolls
    // back and pgTransaction's own finally releases them (no double release).
    if (!opened && !failure) fail(new Error('Native acquisition barrier cancelled'));
    await barrierSettled;
    if (failure) for (const client of active) client.connection.stream.destroy();
    pool.connect = original;
    for (const [client, query] of clients) client.query = query;
    pool.off('connect', onConnect); pool.off('acquire', onAcquire); pool.off('release', onRelease);
    report({ NATIVE_FINANCE_RACE: { nativeBackendPids: pids, trace,
      settlements: settled?.map(result => result.status === 'fulfilled' ? result : { status: result.status, reason: errorDetails(result.reason) }),
      failure: failure ? errorDetails(failure) : null, finalPool: state() } });
  }
}
