const { PGlite } = require('@electric-sql/pglite');
const { btree_gist } = require('@electric-sql/pglite/contrib/btree_gist');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const backend = path.join(__dirname, '..');
const execute = promisify(execFile);
const offlineUrl = 'postgresql://offline:offline@127.0.0.1:1/offline';

function fixtureEnv(databaseUrl) {
  const env = { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'production',
    DOTENV_CONFIG_PATH: path.join(__dirname, 'fixtures', 'absent.env'),
    MAIL_HOST: '127.0.0.1', MAIL_PORT: '1', USER_SERVICE_URL: 'http://127.0.0.1:1' };
  delete env.MAIL_USER;
  delete env.MAIL_PASS;
  delete env.NODE_OPTIONS;
  return env;
}

async function prismaCli(args, databaseUrl = offlineUrl) {
  return execute(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
    cwd: backend, env: fixtureEnv(databaseUrl), timeout: 30000, maxBuffer: 1024 * 1024,
  });
}

// 실제 PostgreSQL WASM 엔진과 wire protocol. 원격 DB 및 영속 디렉터리를 사용하지 않는다.
async function startDatabase() {
  const db = await PGlite.create({ extensions: { btree_gist } });
  // Prisma CLI는 클라이언트 풀과 별도로 연결을 연다. 쿼리는 PGlite 큐에서 직렬화된다.
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 10 });
  try {
    await server.start();
  } catch (error) {
    await db.close();
    throw error;
  }
  return {
    db, server,
    url: `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&connect_timeout=3`,
    async close() { await server.stop(); await db.close(); },
  };
}
module.exports = { startDatabase, prismaCli, fixtureEnv, backend };
