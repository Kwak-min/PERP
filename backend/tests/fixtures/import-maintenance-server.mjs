import { mock } from 'node:test';
import { once } from 'node:events';

mock.timers.enable({ apis: ['setInterval'] });
const { server } = await import('../../src/server.js');
if (!server.listening) await once(server, 'listening', { signal: AbortSignal.timeout(10000) });
process.on('message', message => {
  if (message === 'tick') mock.timers.tick(3600000);
  if (message === 'shutdown') process.emit('SIGTERM');
});
process.send({ ready: true, port: server.address().port });
