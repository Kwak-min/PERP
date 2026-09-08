import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

// 방어 경계이지 악성 자식 코드에 대한 OS sandbox는 아니다. 테스트의 실수로 운영망에 접속하지 못하게 한다.
export const protectedPorts = new Set([8000, 5174, 8080, 55432]);
export const networkAudit = { connections: [], blocked: [] };
// 실제 listening 사건을 받은 픽스처만 호출한다. 프로세스별 정확한 endpoint이며 자식에게 전파하지 않는다.
const fixtureEndpoints = new Set();
export function registerFixtureEndpoint({ address, family, port }) {
  const key = `${address}:${port}`;
  if (process.env.DEADLINE_ISOLATED !== '1' || address !== '127.0.0.2' || family !== 'IPv4'
    || !Number.isInteger(port) || port < 1024 || port > 65535 || protectedPorts.has(port) || fixtureEndpoints.has(key)) {
    const error = new Error(`DEADLINE_FIXTURE_ENDPOINT_DENIED ${key}`);
    error.code = 'DEADLINE_FIXTURE_ENDPOINT_DENIED';
    throw error;
  }
  fixtureEndpoints.add(key);
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    fixtureEndpoints.delete(key);
  };
}

const connect = net.Socket.prototype.connect;
if (process.env.DEADLINE_ISOLATED === '1') {
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof first[0] === 'object' ? first[0] : { port: first[0], host: typeof first[1] === 'string' ? first[1] : 'localhost' };
    // Node IPC/named pipes는 로컬 프로세스 통신이다.
    if (options.path || (typeof first[0] === 'string' && !/^\d+$/.test(first[0]))) return connect.apply(this, args);
    const host = options.host ?? 'localhost', port = Number(options.port);
    const destination = { host, port };
    const loopback = ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host);
    const dependency = process.env.DEADLINE_NETWORK === 'dependencies' && port === 443 && ['registry.npmjs.org', 'nodejs.org'].includes(host);
    if (protectedPorts.has(port) || port === 1 || (!loopback && !dependency && !fixtureEndpoints.has(`${host}:${port}`))) {
      networkAudit.blocked.push(destination);
      const error = new Error(`DEADLINE_NETWORK_DENIED ${host}:${port}`);
      error.code = 'DEADLINE_NETWORK_DENIED';
      throw error;
    }
    networkAudit.connections.push(destination);
    return connect.apply(this, args);
  };
  syncBuiltinESMExports();
}
