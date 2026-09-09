import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../../backend/src/app.js';
import { closeDb } from '../../backend/src/config/db.js';
import { closePgPool } from '../../backend/src/config/pg.js';
if(process.env.DEADLINE_ISOLATED!=='1'||!process.send)throw new Error('isolated IPC required');
const server=createServer(createApp()),streams=new Set();
server.prependListener('request',(req,res)=>{
 if(req.url?.endsWith('/wiki/events')){
  streams.add(res);res.once('close',()=>streams.delete(res));
  process.send({type:'stream-open',cursor:req.headers['last-event-id']??null,hasBearer:!!req.headers.authorization,url:req.url});
 }
});
const listening=once(server,'listening',{signal:AbortSignal.timeout(10000)});server.listen(0,'127.0.0.1');await listening;
process.send({type:'ready',port:server.address().port,pid:process.pid});
process.on('message',message=>{
 if(message.type==='close-streams'){for(const res of streams)res.end();process.send({type:'streams-closed'});return;}
 if(message.type!=='close')throw new Error('unknown command');
 void (async()=>{for(const res of streams)res.end();await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});closeDb();await closePgPool();process.send({type:'closed'});process.disconnect();})().catch(error=>{console.error(error);process.exitCode=1;process.disconnect();});
});
