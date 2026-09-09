import { db } from '../config/db.js';
import { pgQuery } from '../config/pg.js';
import { wikiContext } from './knowledge-wiki-store.service.js';
import { localModelConfiguration } from './knowledge-wiki-compiler.service.js';
import { runWikiJob, WIKI_JOB_POLICY } from './knowledge-wiki-jobs.service.js';
import { wikiError } from './knowledge-wiki-contract.service.js';

export function configuredWikiModel() {
  if (!process.env.WIKI_LOCAL_MODEL_CONFIG) return null;
  let value;
  try { value=JSON.parse(process.env.WIKI_LOCAL_MODEL_CONFIG); } catch { throw wikiError('LOCAL_MODEL_CONFIG',503); }
  return localModelConfiguration(value);
}
// Private startup/maintenance enumeration: scope + actor/job headers only, never input,
// result, titles or arbitrary SQL. Every dispatched job freshly enters scoped authority.
async function headers(store) {
  const select=`SELECT w.store,w.scope,w.tenant_id,w.company_id,w.owner_id,j.actor_id,j.id FROM ${store==='pg' ? 'knowledge.wiki' : 'knowledge_wiki'} w JOIN ${store==='pg' ? 'knowledge.job' : 'knowledge_job'} j ON j.wiki_id=w.id WHERE j.state IN ('queued','running') ORDER BY j.created_at,j.id`;
  return store==='pg' ? (await pgQuery(select)).rows : db().prepare(select).all();
}
export function startWikiWorker({stores=['legacy','pg'],onError=event=>console.error('[wiki-worker]',JSON.stringify(event))}={}) {
  if (!Array.isArray(stores) || stores.some(s=>!['legacy','pg'].includes(s))) throw new Error('invalid Wiki worker stores');
  const abort=new AbortController(); let running=null,stopped=false;
  async function drain() {
    for (const store of stores) {
      let pending;
      try { pending=await headers(store); }
      catch(error) { onError({store,code:error.code ?? 'WIKI_STORAGE_UNAVAILABLE'}); continue; }
      for (const header of pending) {
        if (stopped) return;
        try {
          const context=wikiContext({store:header.store,scope:header.scope,actorId:header.actor_id,tenantId:header.tenant_id,companyId:header.company_id});
          await runWikiJob(context,header.id,{signal:abort.signal});
        } catch(error) { onError({store,job_id:header.id,code:error.code ?? 'WIKI_WORKER_FAILURE'}); }
      }
    }
  }
  const wake=()=>{
    if (stopped || running) return running;
    running=drain().finally(()=>{running=null;}); return running;
  };
  const timer=setInterval(wake,WIKI_JOB_POLICY.heartbeat_ms);timer.unref();
  process.on('orbitflow:wiki-job-queued',wake);
  wake();
  return Object.freeze({wake,async stop(){stopped=true;clearInterval(timer);process.off('orbitflow:wiki-job-queued',wake);abort.abort();await running;}});
}
