// 두 저장소의 동형 계약. PG 배포 파일은 knowledgeDDL('pg')의 고정 산출물이다.
const scoped = 'wiki_id TEXT NOT NULL, id TEXT NOT NULL';
const tables = {
  wiki: `id TEXT PRIMARY KEY, store TEXT NOT NULL CHECK(store IN ('legacy','pg')), scope TEXT NOT NULL CHECK(scope IN ('personal','company')),
    tenant_id TEXT, company_id TEXT, owner_id TEXT, generation INTEGER NOT NULL DEFAULT 1,
    active_schema_id TEXT, created_at TEXT NOT NULL,
    CHECK(tenant_id IS NULL OR length(tenant_id)>0), CHECK(company_id IS NULL OR length(company_id)>0), CHECK(owner_id IS NULL OR length(owner_id)>0),
    CHECK((store='pg' AND tenant_id IS NULL AND ((scope='personal' AND company_id IS NULL AND owner_id IS NOT NULL) OR (scope='company' AND company_id IS NOT NULL AND owner_id IS NULL))) OR
      (store='legacy' AND tenant_id IS NOT NULL AND company_id IS NOT NULL AND ((scope='personal' AND owner_id IS NOT NULL) OR (scope='company' AND owner_id IS NULL))))`,
  schema_revision: `${scoped}, rules_md TEXT NOT NULL, rules_sha256 TEXT NOT NULL, compiler_version TEXT NOT NULL, created_at TEXT NOT NULL`,
  source: `${scoped}, kind TEXT NOT NULL CHECK(kind IN ('record','upload')), origin_kind TEXT, origin_id TEXT,
    current_revision_id TEXT, access_version INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
    registered_by TEXT NOT NULL, withdrawn_at TEXT, created_at TEXT NOT NULL,
    CHECK((kind='record' AND origin_kind IS NOT NULL AND origin_kind IN ('note','document') AND origin_id IS NOT NULL AND length(origin_id)>0) OR (kind='upload' AND origin_kind IS NULL AND origin_id IS NULL))`,
  source_revision: `${scoped}, source_id TEXT NOT NULL, extraction_revision_id TEXT NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL, original_base64 TEXT NOT NULL, original_sha256 TEXT NOT NULL,
    content_sha256 TEXT NOT NULL, origin_version TEXT, restrictions_json TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(wiki_id,source_id,id), UNIQUE(wiki_id,extraction_revision_id)`,
  page: `${scoped}, kind TEXT NOT NULL CHECK(kind IN ('page','entity','concept')), published_head_id TEXT,
    version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'withdrawn' CHECK(state IN ('published','withdrawn')), created_at TEXT NOT NULL`,
  page_revision: `${scoped}, page_id TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, index_entry TEXT NOT NULL,
    content_sha256 TEXT NOT NULL, citations_json TEXT NOT NULL, links_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
    input_manifest_hash TEXT NOT NULL, schema_revision_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(wiki_id,page_id,id)`,
  job: `${scoped}, operation TEXT NOT NULL CHECK(operation IN ('ingest','query','lint')), request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
    actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','unavailable')),
    fence INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until TEXT, current_attempt_id TEXT, input_manifest_hash TEXT,
    source_vector_json TEXT NOT NULL, target_vector_json TEXT NOT NULL, schema_revision_id TEXT NOT NULL,
    config_version TEXT NOT NULL, model_version TEXT, result_json TEXT, result_hash TEXT, failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(wiki_id,actor_id,idempotency_key)`,
  job_attempt: `${scoped}, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3), fence INTEGER NOT NULL,
    lease_owner TEXT NOT NULL, model_version TEXT NOT NULL, config_json TEXT NOT NULL, input_manifest_hash TEXT NOT NULL,
    result_hash TEXT, started_at TEXT NOT NULL, finished_at TEXT, failure_code TEXT,
    UNIQUE(wiki_id,job_id,ordinal), UNIQUE(wiki_id,job_id,id), UNIQUE(wiki_id,job_id,fence)`,
  job_input: `${scoped}, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    kind TEXT NOT NULL CHECK(kind IN ('source_revision','page_revision','catalog','question','instruction','schema_revision','prior_result')),
    source_revision_id TEXT, page_revision_id TEXT, schema_revision_id TEXT, supplied_text TEXT NOT NULL, supplied_sha256 TEXT NOT NULL,
    authorization_json TEXT NOT NULL, classification TEXT NOT NULL, raw_closure_json TEXT NOT NULL, input_json TEXT NOT NULL,
    UNIQUE(wiki_id,attempt_id,ordinal),
    CHECK((kind='source_revision' AND source_revision_id IS NOT NULL AND page_revision_id IS NULL AND schema_revision_id IS NULL) OR
      (kind='page_revision' AND page_revision_id IS NOT NULL AND source_revision_id IS NULL AND schema_revision_id IS NULL) OR
      (kind='schema_revision' AND schema_revision_id IS NOT NULL AND source_revision_id IS NULL AND page_revision_id IS NULL) OR
      (kind IN ('catalog','question','instruction','prior_result') AND source_revision_id IS NULL AND page_revision_id IS NULL AND schema_revision_id IS NULL))`,
  dependency: `${scoped}, dependent_page_revision_id TEXT, dependent_job_id TEXT, dependent_change_set_id TEXT,
    source_revision_id TEXT, page_revision_id TEXT, relation TEXT NOT NULL CHECK(relation IN ('direct','transitive')),
    CHECK((CASE WHEN dependent_page_revision_id IS NULL THEN 0 ELSE 1 END + CASE WHEN dependent_job_id IS NULL THEN 0 ELSE 1 END + CASE WHEN dependent_change_set_id IS NULL THEN 0 ELSE 1 END)=1),
    CHECK((CASE WHEN source_revision_id IS NULL THEN 0 ELSE 1 END + CASE WHEN page_revision_id IS NULL THEN 0 ELSE 1 END)=1)`,
  change_set: `${scoped}, actor_id TEXT NOT NULL, job_id TEXT, state TEXT NOT NULL CHECK(state IN ('draft','published','rejected')),
    proposed_revisions_json TEXT NOT NULL, expected_heads_json TEXT NOT NULL, lineage_json TEXT NOT NULL,
    schema_revision_id TEXT NOT NULL, input_manifest_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL`,
  publication: `${scoped}, change_set_id TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    manifest_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(wiki_id,idempotency_key), UNIQUE(wiki_id,change_set_id)`,
  event: `${scoped}, sequence INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT NOT NULL, page_revision_id TEXT, source_revision_id TEXT,
    job_id TEXT, change_set_id TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(wiki_id,sequence)`,
};
const refs = [];
for (const table of Object.keys(tables).filter(x => x !== 'wiki')) refs.push([table,'wiki_id','wiki','id']);
const ref = (table, column, target, targetColumn = 'id') => refs.push([table,`wiki_id,${column}`,target,`wiki_id,${targetColumn}`]);
refs.push(['wiki','id,active_schema_id','schema_revision','wiki_id,id']);
ref('source','id,current_revision_id','source_revision','source_id,id');
ref('source_revision','source_id','source');
ref('page','id,published_head_id','page_revision','page_id,id');
ref('page_revision','page_id','page'); ref('page_revision','schema_revision_id','schema_revision');
ref('job','schema_revision_id','schema_revision'); ref('job','id,current_attempt_id','job_attempt','job_id,id');
ref('job_attempt','job_id','job'); ref('job_input','job_id,attempt_id','job_attempt','job_id,id');
for (const [column,target] of [['source_revision_id','source_revision'],['page_revision_id','page_revision'],['schema_revision_id','schema_revision']]) ref('job_input',column,target);
for (const [column,target] of [['dependent_page_revision_id','page_revision'],['dependent_job_id','job'],['dependent_change_set_id','change_set'],['source_revision_id','source_revision'],['page_revision_id','page_revision']]) ref('dependency',column,target);
ref('change_set','job_id','job'); ref('change_set','schema_revision_id','schema_revision');
ref('publication','change_set_id','change_set');
for (const [column,target] of [['page_revision_id','page_revision'],['source_revision_id','source_revision'],['job_id','job'],['change_set_id','change_set']]) ref('event',column,target);
export const KNOWLEDGE_TABLES = Object.freeze(Object.keys(tables));
const immutable = ['source_revision','page_revision','schema_revision','job_input','dependency','publication','event'];
export function knowledgeDDL(dialect) {
  const pg = dialect === 'pg', name = table => pg ? `knowledge.${table}` : `knowledge_${table}`;
  const foreign = ([,columns,target,targetColumns]) => `FOREIGN KEY(${columns}) REFERENCES ${name(target)}(${targetColumns}) DEFERRABLE INITIALLY DEFERRED`;
  let sql = pg ? 'BEGIN;\nCREATE SCHEMA IF NOT EXISTS knowledge;\n' : '';
  for (const [table, fields] of Object.entries(tables)) {
    sql += `CREATE TABLE ${pg ? 'IF NOT EXISTS ' : ''}${name(table)} (${fields}${table === 'wiki' ? '' : ', PRIMARY KEY(wiki_id,id)'}${pg ? '' : refs.filter(r => r[0] === table).map(r => ',\n  ' + foreign(r)).join('')});\n`;
  }
  // Cyclic FKs require all tables first. Match the complete FK contract rather than
  // names: the original deployment used PostgreSQL-assigned constraint names.
  if (pg) {
    const columns = value => `ARRAY[${value.split(',').map(c => `'${c}'`).join(',')}]`;
    sql += `DO $$ DECLARE edge RECORD; BEGIN
  FOR edge IN SELECT * FROM (VALUES
    ${refs.map(([table,keys,target,targetKeys]) => `('${name(table)}',${columns(keys)},'${name(target)}',${columns(targetKeys)})`).join(',\n    ')}
  ) AS edges(relation,columns,target,target_columns) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
      WHERE c.contype='f' AND c.conrelid=edge.relation::regclass AND c.confrelid=edge.target::regclass
        AND c.condeferrable AND c.condeferred AND c.convalidated
        AND c.confupdtype='a' AND c.confdeltype='a' AND c.confmatchtype='s'
        AND c.conkey=ARRAY(SELECT a.attnum FROM unnest(edge.columns) WITH ORDINALITY k(name,position)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname=k.name ORDER BY k.position)
        AND c.confkey=ARRAY(SELECT a.attnum FROM unnest(edge.target_columns) WITH ORDINALITY k(name,position)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attname=k.name ORDER BY k.position)) THEN
      EXECUTE format('ALTER TABLE %s ADD FOREIGN KEY(%s) REFERENCES %s(%s) DEFERRABLE INITIALLY DEFERRED',
        edge.relation::regclass,array_to_string(edge.columns,','),edge.target::regclass,array_to_string(edge.target_columns,','));
    END IF;
  END LOOP;
END $$;\n`;
  }
  sql += `CREATE UNIQUE INDEX ${pg ? 'IF NOT EXISTS ' : ''}knowledge_wiki_scope ON ${name('wiki')}(store,scope,COALESCE(tenant_id,''),COALESCE(company_id,''),COALESCE(owner_id,''));\n`;
  sql += `CREATE UNIQUE INDEX ${pg ? 'IF NOT EXISTS ' : ''}knowledge_source_origin ON ${name('source')}(wiki_id,origin_kind,origin_id) WHERE kind='record';\n`;
  if (pg) sql += `CREATE OR REPLACE FUNCTION knowledge.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'knowledge immutable row'; END $$;\n`;
  for (const table of immutable) {
    if (pg) sql += `CREATE OR REPLACE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON ${name(table)} FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();\n`;
    else for (const action of ['UPDATE','DELETE']) sql += `CREATE TRIGGER knowledge_${table}_${action.toLowerCase()} BEFORE ${action} ON ${name(table)} BEGIN SELECT RAISE(ABORT,'knowledge immutable row'); END;\n`;
  }
  const protectedFields = {
    wiki:['id','store','scope','tenant_id','company_id','owner_id','created_at'],
    source:['wiki_id','id','kind','origin_kind','origin_id','registered_by','created_at'],
    page:['wiki_id','id','kind','created_at'],
    job:['wiki_id','id','operation','request_json','request_hash','actor_id','idempotency_key','source_vector_json','target_vector_json','schema_revision_id','config_version','created_at'],
    job_attempt:['wiki_id','id','job_id','ordinal','fence','lease_owner','model_version','config_json','input_manifest_hash','started_at'],
    change_set:['wiki_id','id','actor_id','job_id','proposed_revisions_json','expected_heads_json','lineage_json','schema_revision_id','input_manifest_hash','manifest_hash','created_at'],
  };
  for (const [table,columns] of Object.entries(protectedFields)) {
    const changed = columns.map(c => `OLD.${c} IS DISTINCT FROM NEW.${c}`).join(' OR ');
    if (pg) sql += `CREATE OR REPLACE TRIGGER immutable_fields BEFORE UPDATE ON ${name(table)} FOR EACH ROW WHEN (${changed}) EXECUTE FUNCTION knowledge.immutable_row();\n`;
    else sql += `CREATE TRIGGER knowledge_${table}_fields BEFORE UPDATE ON ${name(table)} WHEN ${changed} BEGIN SELECT RAISE(ABORT,'knowledge immutable fields'); END;\n`;
    if (pg) sql += `CREATE OR REPLACE TRIGGER immutable_delete BEFORE DELETE ON ${name(table)} FOR EACH ROW EXECUTE FUNCTION knowledge.immutable_row();\n`;
    else sql += `CREATE TRIGGER knowledge_${table}_delete BEFORE DELETE ON ${name(table)} BEGIN SELECT RAISE(ABORT,'knowledge immutable row'); END;\n`;
  }
  return sql + (pg ? 'COMMIT;\n' : '');
}
