const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');

// 실제 Server의 listening 이벤트만 관찰한다. listen/connect/app/Prisma를 대체하지 않는다.
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  const result = emit.call(this, event, ...args);
  if (event === 'listening') {
    let guardBlocked = false;
    if (process.env.DEADLINE_ISOLATED === '1') {
      // guard를 여기서 import하면 상속 결함을 숨기므로 실제 connect 거부를 관찰한다.
      assert.throws(() => {
        const socket = net.connect({ host: 'example.invalid', port: 443 });
        socket.destroy();
      }, { code: 'DEADLINE_NETWORK_DENIED' });
      guardBlocked = true;
    }
    process.send({ kind: 'listening', address: this.address(), guardBlocked });
  }
  return result;
};

// Node의 --import 경로에서도 TS 소스를 ESM으로 재해석하지 않도록 CJS로 진입한다.
if (require.main === module) require(process.argv[2]);
