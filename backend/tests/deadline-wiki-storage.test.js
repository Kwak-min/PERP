import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { startDeadlineServer } from './deadline-fixture.js';
import { exerciseSources, exerciseRetrieval } from './deadline-wiki-fixture.js';
import { knowledgeDDL } from '../src/config/knowledge-schema.js';
import { exerciseAuthorization } from './deadline-wiki-authorization.js';

test('SQLite source HTTP: scope, immutable capture, exact history, CAS, uniqueness and original preservation', { timeout: 60000 }, async () => {
  const api = await startDeadlineServer();
  const evidence = new URL(`../../.omo/evidence/task-31-revision/storage-${process.env.DEADLINE_RUN_ID}/`, import.meta.url);
  await mkdir(evidence, { recursive: true });
  try {
    const fixture = await exerciseSources(api);
    await exerciseRetrieval(api, fixture);
    await exerciseAuthorization(api, fixture);
    const { db } = await import('../src/config/db.js');
    assert.deepEqual(db().prepare('SELECT version FROM schema_migration ORDER BY version').all().map(x => x.version), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,21,22,23]);
    assert.throws(() => db().exec("UPDATE knowledge_source_revision SET title='tampered'"), /immutable/);
    assert.throws(() => db().exec('DELETE FROM knowledge_source_revision'), /immutable/);
    assert.throws(() => db().exec("INSERT INTO knowledge_wiki(id,store,scope,tenant_id,company_id,owner_id,created_at) SELECT id||'-duplicate',store,scope,tenant_id,company_id,owner_id,created_at FROM knowledge_wiki LIMIT 1"),/UNIQUE/);
    const snapshot = db().prepare('SELECT id,original_sha256,content_sha256 FROM knowledge_source_revision ORDER BY id').all();
    const {closeDb} = await import('../src/config/db.js');
    closeDb();
    assert.deepEqual(db().prepare('SELECT id,original_sha256,content_sha256 FROM knowledge_source_revision ORDER BY id').all(),snapshot,'source hashes survive SQLite close/reopen');
    assert.equal((await readFile(new URL('../../db/perp_additions_v15_knowledge_wiki.sql', import.meta.url),'utf8')).replaceAll('\r\n', '\n'), knowledgeDDL('pg').replaceAll('\r\n', '\n'));
  } finally {
    await api.close();
    await writeFile(new URL('sqlite-http.json', evidence), JSON.stringify({ http: api.http, cleanup: api.resource }, null, 2));
  }
});
