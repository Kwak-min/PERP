const { once } = require('node:events');
const http = require('node:http');

// 실제 Express/인증/서비스를 실행하는 명시적 Prisma 경계 픽스처. PostgreSQL 서버가 아니다.
async function startSpaceFixture(authorityUrl) {
  process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/never_connect';
  const { prisma } = require('../src/lib/prisma');
  const app = require('../src/app').default;
  const originals = { findMany: prisma.space.findMany, findFirst: prisma.space.findFirst, create: prisma.space.create, update: prisma.space.update, transaction: prisma.$transaction };
  const previousAuthority = process.env.ERP_API_URL;
  process.env.ERP_API_URL = authorityUrl;
  let rows = [], sequence = 0, tail = Promise.resolve(), failName = null;
  const calls = [];
  const matches = (row, where) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    if (value && typeof value === 'object' && 'gte' in value) return row[key] >= value.gte;
    if (key === 'reservations') return true; // 이 픽스처에는 예약이 없다.
    return row[key] === value;
  });
  const model = (getRows) => ({
    async findMany({ where }) { calls.push({ op: 'findMany', where }); return getRows().filter(row => matches(row, where)); },
    async findFirst({ where }) { calls.push({ op: 'findFirst', where }); return getRows().find(row => matches(row, where)) ?? null; },
    async create({ data }) {
      calls.push({ op: 'create', data });
      if (data.name === failName) throw new Error('injected transaction failure');
      const row = { id: ++sequence, floor: null, amenities: null, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...data };
      getRows().push(row); return row;
    },
    async update({ where, data }) { const row = getRows().find(row => matches(row, where)); if (!row) throw new Error('missing fixture row'); Object.assign(row, data); return row; },
  });
  Object.assign(prisma.space, model(() => rows));
  prisma.$transaction = async callback => {
    // FIFO는 타이머가 아니라 트랜잭션 종료 신호를 기다린다. SQL 잠금도 서비스가 먼저 요청해야 한다.
    const previous = tail; let release; tail = new Promise(resolve => { release = resolve; });
    await previous;
    const pending = structuredClone(rows); let locked = false;
    const txModel = model(() => { if (!locked) throw new Error('transaction read/write before advisory lock'); return pending; });
    try {
      const result = await callback({ space: txModel, async $executeRaw(strings, ...values) {
        const sql = strings.join('?');
        if (!sql.includes('pg_advisory_xact_lock') || values.length !== 2) throw new Error('unexpected fixture SQL');
        calls.push({ op: 'lock', values }); locked = true; return 1;
      } });
      rows = pending; return result;
    } finally { release(); }
  };
  const server = http.createServer(app);
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(5000) }); server.listen(0, '127.0.0.1'); await ready;
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`, calls, get rows() { return rows; },
    set failName(value) { failName = value; },
    async insert(data) { return prisma.space.create({ data }); },
    async close() {
      const closed = once(server, 'close', { signal: AbortSignal.timeout(5000) }); server.close(); await closed;
      Object.assign(prisma.space, { findMany: originals.findMany, findFirst: originals.findFirst, create: originals.create, update: originals.update });
      prisma.$transaction = originals.transaction;
      if (previousAuthority === undefined) delete process.env.ERP_API_URL; else process.env.ERP_API_URL = previousAuthority;
      await prisma.$disconnect();
    },
  };
}
module.exports = { startSpaceFixture };
