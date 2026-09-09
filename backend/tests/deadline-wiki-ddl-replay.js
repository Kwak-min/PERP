import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { knowledgeDDL, KNOWLEDGE_TABLES } from '../src/config/knowledge-schema.js';
import { knowledgeInvalidationDDL } from '../src/config/knowledge-invalidation-schema.js';

// Raw deployment SQL and the authoritative generators must both replay, not just a migration ledger.
export async function exerciseDDLReplay(pool, { populated = false } = {}) {
  const migrations = [
    ['perp_additions_v15_knowledge_wiki.sql', knowledgeDDL('pg')],
    ['perp_additions_v18_knowledge_invalidation.sql', knowledgeInvalidationDDL('pg')],
  ];
  const shipped = await Promise.all(migrations.map(async ([file, generated]) => {
    const sql = (await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(sql, generated.replaceAll('\r\n', '\n'), file);
    return sql;
  }));
  async function snapshot() {
    const rows = {};
    for (const table of KNOWLEDGE_TABLES) rows[table] = (await pool.query(`SELECT * FROM knowledge.${table} ORDER BY id`)).rows;
    return {
      rows,
      rowHash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      erp: (await pool.query('SELECT id,email,password_hash FROM auth.users ORDER BY id')).rows,
      constraints: (await pool.query(`SELECT oid, conrelid::regclass::text AS relation, conname, contype,
        condeferrable, condeferred, convalidated, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace='knowledge'::regnamespace ORDER BY oid`)).rows,
      triggers: (await pool.query(`SELECT oid, tgrelid::regclass::text AS relation, tgname, tgenabled, pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE NOT tgisinternal AND (tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='knowledge'::regnamespace) OR tgname LIKE 'wiki_%') ORDER BY oid`)).rows,
      indexes: (await pool.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='knowledge' ORDER BY indexname")).rows,
      functions: (await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='knowledge'::regnamespace ORDER BY oid")).rows,
    };
  }
  const before = await snapshot();
  assert.equal(before.constraints.filter(c => c.contype === 'f').length, 37);
  assert.ok(before.constraints.filter(c => c.contype === 'f').every(c => c.condeferrable && c.condeferred && c.convalidated));
  // First replay uses the shipped files, second uses both generators directly.
  for (const sqls of [shipped, migrations.map(([, sql]) => sql)]) {
    for (const sql of sqls) await pool.query(sql);
    assert.deepEqual(await snapshot(), before, 'replay preserves every row/hash and existing constraint/trigger identity');
  }
  if (populated) {
    for (const table of ['wiki', 'source', 'source_revision', 'page_revision', 'publication', 'event']) assert.ok(before.rows[table].length > 0, table);
    for (const row of before.rows.source_revision) {
      assert.equal(createHash('sha256').update(Buffer.from(row.original_base64, 'base64')).digest('hex'), row.original_sha256);
      assert.equal(createHash('sha256').update(row.content).digest('hex'), row.content_sha256);
    }
    for (const table of ['source_revision', 'page_revision', 'publication', 'event']) {
      await assert.rejects(pool.query(`UPDATE knowledge.${table} SET id=id||'-tampered'`), /immutable/);
      await assert.rejects(pool.query(`DELETE FROM knowledge.${table}`), /immutable/);
    }
    await assert.rejects(pool.query("UPDATE knowledge.wiki SET owner_id='tampered'"), /immutable/);
    await assert.rejects(pool.query("INSERT INTO knowledge.wiki SELECT (jsonb_populate_record(NULL::knowledge.wiki, to_jsonb(w)||jsonb_build_object('id',$1::text))).* FROM knowledge.wiki w LIMIT 1", [randomUUID()]), error => error.code === '23505');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const source = before.rows.source[0];
      // The UPDATE must succeed; the deferred composite FK must reject COMMIT and roll back invalidation too.
      await client.query('UPDATE knowledge.source SET current_revision_id=$1 WHERE wiki_id=$2 AND id=$3', [randomUUID(), source.wiki_id, source.id]);
      await assert.rejects(client.query('COMMIT'), error => error.code === '23503');
    } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
    assert.deepEqual(await snapshot(), before, 'immutable/FK failures change neither stored history nor generation/fence');
  }
  return { populated, rowHash: before.rowHash, rows: Object.fromEntries(Object.entries(before.rows).map(([table, rows]) => [table, rows.length])), foreignKeys: before.constraints.filter(c => c.contype === 'f').length, triggers: before.triggers.length, replayApplications: 2 };
}
