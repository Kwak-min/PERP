// 격리 테스트 전용 독립 API process. compiler/worker capability가 아니다.
import express from 'express';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {knowledgeWikiPublicationRouter} from '../src/routes/knowledge-wiki-publication.routes.js';
import {errorHandler,requestContext} from '../src/middleware/error.js';
import {closeDb,db} from '../src/config/db.js';
import {closePgPool} from '../src/config/pg.js';
if(process.env.DEADLINE_ISOLATED!=='1'||!process.send) throw new Error('isolated IPC fixture required');
db();
const app=express();app.use(express.json(),requestContext);app.use('/api/v1/documents/wiki',knowledgeWikiPublicationRouter('legacy','company'));app.use(errorHandler);
const server=createServer(app);const ready=once(server,'listening',{signal:AbortSignal.timeout(10000)});server.listen(0,'127.0.0.1');await ready;
process.send({type:'ready',port:server.address().port});
async function close(){await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});closeDb();await closePgPool();process.send({type:'closed'});process.disconnect();}
process.once('message',message=>{if(message?.type!=='close')throw new Error('unexpected IPC');void close().catch(error=>{console.error(error);process.exitCode=1;process.disconnect();});});
