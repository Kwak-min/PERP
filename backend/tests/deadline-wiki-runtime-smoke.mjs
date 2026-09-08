import assert from 'node:assert/strict';
import {Server} from 'node:net';
import {once,EventEmitter} from 'node:events';
import {setupJobs} from './deadline-wiki-jobs-fixture.js';

// Exercise the shipped server entry and graceful worker shutdown against owned DBs.
const fixture=await setupJobs('pg'),signals=new EventEmitter();
const originalListen=Server.prototype.listen,originalExit=process.exit;
const ready=once(signals,'ready',{signal:AbortSignal.timeout(10000)});
Server.prototype.listen=function(...args){
  const listening=once(this,'listening',{signal:AbortSignal.timeout(10000)});
  listening.then(()=>signals.emit('ready',this),error=>signals.emit('error',error));
  return originalListen.apply(this,args);
};
process.exit=code=>signals.emit('exitRequested',code);
let server,health,exitCode;
try {
  await import('../src/server.js');
  [server]=await ready;Server.prototype.listen=originalListen;
  const response=await fetch(`http://127.0.0.1:${server.address().port}/health`,{signal:AbortSignal.timeout(10000)});
  health=await response.json();assert.equal(response.status,200);assert.equal(health.status,'ok');
  const stopped=once(signals,'exitRequested',{signal:AbortSignal.timeout(10000)});
  process.emit('SIGTERM');[exitCode]=await stopped;assert.equal(exitCode,0);assert.equal(server.listening,false);
  console.log(JSON.stringify({entry:'backend/src/server.js',health,exitCode,worker_shutdown_awaited:true}));
}finally{
  Server.prototype.listen=originalListen;process.exit=originalExit;
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  await fixture.close({runtime:true,health,exitCode});
}
