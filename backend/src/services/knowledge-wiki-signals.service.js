import {watch} from 'node:fs';
import path from 'node:path';
import {env} from '../config/env.js';
import {wikiWakePath} from '../config/knowledge-wake.js';
import {pgPool} from '../config/pg.js';
import {withKnowledgeTransaction} from './knowledge-wiki-store.service.js';

// One LISTEN connection per process, not per stream. Payloads are wake hints only.
const pgSubscribers=new Set();
let pgListener=null;
async function listenPg(subscriber){
  pgSubscribers.add(subscriber);
  if(!pgListener)pgListener=(async()=>{
    const client=await pgPool.connect();
    const notification=message=>{if(message.channel==='orbitflow_wiki_invalidated')for(const entry of pgSubscribers)void entry.refresh();};
    const error=error=>{for(const entry of [...pgSubscribers])entry.onError(error);};
    client.on('notification',notification);client.on('error',error);
    try{await client.query('LISTEN orbitflow_wiki_invalidated');}
    catch(error){client.off('notification',notification);client.off('error',error);client.release(true);throw error;}
    return {client,notification,error};
  })();
  let listener;
  try{listener=await pgListener;}catch(error){pgSubscribers.delete(subscriber);if(!pgSubscribers.size)pgListener=null;throw error;}
  return ()=>{
    pgSubscribers.delete(subscriber);
    if(!pgSubscribers.size){listener.client.off('notification',listener.notification);listener.client.off('error',listener.error);listener.client.release(true);pgListener=null;}
  };
}

// Identity exists before the Wiki row does. Never derive it from notification payloads.
export const wikiScopeKey=context=>JSON.stringify([context.store,context.scope,context.tenantId,context.companyId,context.ownerId]);
export async function subscribeWikiChanges(context,onSignal,onError) {
  const scope_key=wikiScopeKey(context);
  const snapshot=()=>withKnowledgeTransaction(context,{},function*(tx){
    const events=yield* tx.all('event',{orderBy:['sequence']});
    return {store:context.store,scope_key,wiki_id:tx.wiki?.id??null,generation:tx.wiki?.generation??0,cursor:events.at(-1)?.sequence??0};
  });
  let previous,closed=false,busy=false,pending=false,stopExternal;
  const reportError=error=>{if(!closed)onError(error);};
  async function refresh(){
    if(closed)return;
    pending=true;if(busy)return;busy=true;
    try{
      do{
        pending=false;const current=await snapshot();
        const changed=previous && (current.wiki_id!==previous.wiki_id || current.generation!==previous.generation || current.cursor!==previous.cursor);
        previous=current;
        if(!closed && changed)onSignal(current);
      }while(pending&&!closed);
    }catch(error){reportError(error);}finally{busy=false;}
  }
  const localWake=signal=>{if(signal?.store===context.store)void refresh();};
  const close=()=>{
    if(closed)return;closed=true;stopExternal?.();
    process.off('orbitflow:wiki-changed',localWake);process.off('orbitflow:wiki-invalidated',localWake);
  };
  // Subscribe before reading. A hint during any snapshot queues another authoritative read.
  process.on('orbitflow:wiki-changed',localWake);process.on('orbitflow:wiki-invalidated',localWake);
  try{
    if(context.store==='pg')stopExternal=await listenPg({refresh,onError:reportError});
    else if(env.databaseFile!==':memory:'){
      const marker=wikiWakePath(),name=path.basename(marker);
      const watcher=watch(path.dirname(marker),{persistent:false},(_event,filename)=>{if(filename?.toString()===name)void refresh();});
      watcher.on('error',reportError);stopExternal=()=>watcher.close();
    }
    await refresh();
    return close;
  }catch(error){close();throw error;}
}
