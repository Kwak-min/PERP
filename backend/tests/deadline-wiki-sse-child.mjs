import express from 'express';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createApp} from '../src/app.js';
import {knowledgeWikiPublicationRouter} from '../src/routes/knowledge-wiki-publication.routes.js';
import {knowledgeWikiRouter} from '../src/routes/knowledge-wiki.routes.js';
import {pgAuthBridge} from '../src/middleware/pgAuth.js';
import {requestContext,errorHandler} from '../src/middleware/error.js';
import {closeDb} from '../src/config/db.js';
import {closePgPool,pgPool} from '../src/config/pg.js';
if(process.env.DEADLINE_ISOLATED!=='1'||!process.send)throw new Error('isolated IPC fixture required');
const releaseSnapshot=Promise.withResolvers();let eventReads=0;
if(process.argv[2]==='snapshot')pgPool.on('connect',client=>{
  const query=client.query.bind(client);
  client.query=function(...args){
    const result=query(...args);
    // Hold a real REPEATABLE READ result, not a fabricated SQL response.
    if(typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM knowledge.event ')&&++eventReads===2){
      return result.then(async rows=>{
        process.send({type:'snapshot-held'});
        const timeout=AbortSignal.timeout(10000),abort=()=>releaseSnapshot.reject(timeout.reason);
        timeout.addEventListener('abort',abort,{once:true});
        try{await releaseSnapshot.promise;}finally{timeout.removeEventListener('abort',abort);}
        return rows;
      });
    }
    return result;
  };
});
const app=process.argv[2]==='exported'?express():createApp();
if(process.argv[2]==='exported'){
  app.use(express.json(),requestContext,pgAuthBridge);
  for(const store of ['legacy','pg'])for(const scope of ['personal','company']){
    const root=`/api/v1${store==='pg'?'/pg':''}/${scope==='personal'?'vault':'documents'}/wiki`;
    app.use(root,knowledgeWikiPublicationRouter(store,scope),knowledgeWikiRouter(store,scope));
  }
  app.use(errorHandler);
}
const server=createServer(app),ready=once(server,'listening',{signal:AbortSignal.timeout(10000)});
const responses=new Set();
server.prependListener('request',(_req,res)=>{
  const closed=once(res,'close',{signal:AbortSignal.timeout(30000)});responses.add(closed);
  void closed.then(()=>responses.delete(closed));
});
server.listen(0,'127.0.0.1');await ready;
process.send({type:'ready',port:server.address().port});
process.on('message',message=>{
  if(message.type==='release-snapshot'){releaseSnapshot.resolve();return;}
  if(message.type!=='close')throw new Error('unexpected IPC');
  void (async()=>{
    await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
    await Promise.all([...responses]);
    closeDb();await closePgPool();
    process.send({type:'closed',listening:server.listening,changedListeners:process.listenerCount('orbitflow:wiki-changed'),invalidatedListeners:process.listenerCount('orbitflow:wiki-invalidated')});
    process.disconnect();
  })().catch(error=>{console.error(error);process.exitCode=1;process.disconnect();});
});
