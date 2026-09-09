const { workerData } = require('node:worker_threads');
const { Client, Pool } = require('pg');
const port = workerData.limitsPort;
const query = Client.prototype.query, connect = Pool.prototype.connect, clientConnect = Client.prototype.connect;
let poolConnectMs;

// 관찰 전용: 실제 Pool/Client/SQL/잠금을 유지하고 BEGIN 전에 실제 session SHOW를 읽는다.
Pool.prototype.connect = function (...args) {
  poolConnectMs = this.options.connectionTimeoutMillis;
  return connect.apply(this, args);
};
Client.prototype.connect = function (...args) {
  port.postMessage({ type: 'connecting', sslEnabled: Boolean(this.connectionParameters.ssl),
    sslNegotiation: this.connectionParameters.sslnegotiation,
    poolConnectMs, clientConnectMs: this._connectionTimeoutMillis, connectSeconds: this.connectionParameters.connect_timeout });
  return clientConnect.apply(this, args);
};
Client.prototype.query = function (text, ...args) {
  if (text === 'BEGIN') {
    return (async () => {
      const statement = (await query.call(this, 'SHOW statement_timeout')).rows[0].statement_timeout;
      const lock = (await query.call(this, 'SHOW lock_timeout')).rows[0].lock_timeout;
      const application = (await query.call(this, 'SHOW application_name')).rows[0].application_name;
      const timezone = (await query.call(this, 'SHOW timezone')).rows[0].TimeZone;
      port.postMessage({ type: 'limits', statement, lock, application, timezone,
        poolConnectMs, clientConnectMs: this._connectionTimeoutMillis, connectSeconds: this.connectionParameters.connect_timeout,
        ssl: this.connectionParameters.ssl, port: this.connectionParameters.port });
      return query.call(this, text, ...args);
    })();
  }
  const result = query.call(this, text, ...args);
  if (text === 'SELECT id FROM org.companies WHERE id=$1 FOR UPDATE') {
    port.postMessage({ type: 'lock_queued' });
    result.catch(error => port.postMessage({ type: 'lock_error', code: error.code }));
  }
  return result;
};
port.unref();
