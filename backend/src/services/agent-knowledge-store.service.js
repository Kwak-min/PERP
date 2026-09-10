import { db } from '../config/db.js';
import { pgTransaction } from '../config/pg.js';
import { contextIdentity, failKnowledge } from './agent-knowledge-policy.service.js';

// Generator callbacks keep SQLite synchronous: never await inside its transaction.
export async function knowledgeTransaction(context, work) {
  contextIdentity(context);
  const { freshLegacyAgent, freshPgAgent } = await import('./agent-capabilities.service.js');
  if (context.source === 'pg') return pgTransaction(async client => {
    const p = await freshPgAgent(context, client);
    const tx = { p, client, pg: true, query: (sql, args = []) => ({ sql, args }) };
    const iterator = work(tx);
    let step = iterator.next();
    while (!step.done) {
      if (step.value instanceof Promise) { step = iterator.next(await step.value); continue; }
      const { sql, args } = step.value;
      let i = 0;
      step = iterator.next((await client.query(sql.replace(/\?/g, () => `$${++i}`), args)).rows);
    }
    return step.value;
  });
  const conn = db();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const p = freshLegacyAgent(context);
    const iterator = work({ p, pg: false, client: null, query: (sql, args = []) => ({ sql, args }) });
    let step = iterator.next();
    while (!step.done) {
      if (step.value instanceof Promise) throw new Error('Async SQLite transaction forbidden');
      const { sql, args } = step.value;
      step = iterator.next(conn.prepare(sql).all(...args));
    }
    conn.exec('COMMIT');
    return step.value;
  } catch (error) { conn.exec('ROLLBACK'); throw error; }
}

export function requireKnowledgeAccess(p, scope, write = false) {
  if (scope === 'company') {
    p.require(`document.${write ? 'write' : 'read'}`); p.require('menu.documents');
    if (!p.modules.includes('documents')) failKnowledge('MODULE_DISABLED', 403);
  } else if (!p.companyId) p.require('menu.vault');
}
export function canReadCompanyKnowledge(p) {
  return p.has('document.read') && p.has('menu.documents') && p.modules.includes('documents');
}
export function scopedKnowledgeArgs(context) {
  const c = contextIdentity(context);
  return [c.tenantId, c.workspaceId, c.actorId, c.knowledgeMode];
}
export const SCOPED_KNOWLEDGE_WHERE = 'tenant_id=? AND workspace_id=? AND actor_id=? AND knowledge_mode=?';
