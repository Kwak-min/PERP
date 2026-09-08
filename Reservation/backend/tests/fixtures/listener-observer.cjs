const http = require('node:http');

// 실제 Server의 listening 이벤트만 관찰한다. listen/connect/app/Prisma를 대체하지 않는다.
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  const result = emit.call(this, event, ...args);
  if (event === 'listening') process.send({ kind: 'listening', address: this.address() });
  return result;
};
