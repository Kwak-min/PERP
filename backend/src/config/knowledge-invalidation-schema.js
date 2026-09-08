// 원본을 쓰는 모든 경로(일반/Agent/복원/cascade)가 같은 DB fence를 통과한다.
// 이 내부 DDL은 raw SQL consumer capability나 private payload API가 아니다.
export function knowledgeInvalidationDDL(dialect) {
  if (dialect==='pg') return pgDDL();
  const clock="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const invalidate=where=>`
    UPDATE knowledge_job SET fence=fence+1,state='unavailable',lease_owner=NULL,lease_until=NULL,failure_code='SOURCE_REVOKED',updated_at=${clock}
      WHERE state IN ('queued','running') AND wiki_id IN (SELECT id FROM knowledge_wiki WHERE ${where});
    UPDATE knowledge_wiki SET generation=generation+1 WHERE ${where};`;
  let sql='';
  for(const [table,kind] of [['document','document'],['vault_note','note']]) {
    for(const action of ['UPDATE','DELETE']) sql+=`CREATE TRIGGER wiki_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN
      UPDATE knowledge_source SET access_version=access_version+1 WHERE origin_kind='${kind}' AND origin_id=OLD.id
        AND wiki_id IN (SELECT id FROM knowledge_wiki WHERE store='legacy' AND tenant_id=OLD.tenant_id AND company_id=OLD.org_id);
      ${invalidate(`id IN (SELECT wiki_id FROM knowledge_source WHERE origin_kind='${kind}' AND origin_id=OLD.id) AND tenant_id=OLD.tenant_id AND company_id=OLD.org_id`)}
    END;\n`;
  }
  sql+=`CREATE TRIGGER wiki_source_invalidation AFTER UPDATE OF current_revision_id,withdrawn_at ON knowledge_source
    WHEN OLD.current_revision_id IS NOT NULL AND (OLD.current_revision_id IS DISTINCT FROM NEW.current_revision_id OR OLD.withdrawn_at IS DISTINCT FROM NEW.withdrawn_at)
    BEGIN ${invalidate('id=OLD.wiki_id')} END;\n`;
  // Authority changes wake fresh projections, but are not necessarily revocations
  // (e.g. removing only write must preserve read-authorized query leases).
  // Job authority and metadata-only retirement derive the stored operation.
  const authorityChanged=where=>`UPDATE knowledge_wiki SET generation=generation+1 WHERE ${where};`;
  for(const table of ['membership','company_role','organization']) for(const action of ['UPDATE','DELETE']) {
    const scope=table==='organization' ? 'company_id=OLD.id AND tenant_id=OLD.tenant_id' : 'company_id=OLD.org_id AND tenant_id=OLD.tenant_id';
    sql+=`CREATE TRIGGER wiki_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${authorityChanged(scope)} END;\n`;
  }
  for(const [table,scope] of [['app_user',"owner_id=OLD.id OR id IN (SELECT wiki_id FROM knowledge_job WHERE actor_id=OLD.id)"],['tenant','tenant_id=OLD.id']]) for(const action of ['UPDATE','DELETE']) sql+=`CREATE TRIGGER wiki_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${authorityChanged(scope)} END;\n`;
  return sql;
}
function pgDDL() {
  let sql=`CREATE FUNCTION knowledge.generation_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM pg_notify('orbitflow_wiki_invalidated',json_build_object('store','pg','wiki_id',NEW.id,'generation',NEW.generation)::text);
  RETURN NULL;
END $$;
CREATE TRIGGER wiki_generation_changed AFTER UPDATE OF generation ON knowledge.wiki FOR EACH ROW WHEN (OLD.generation IS DISTINCT FROM NEW.generation) EXECUTE FUNCTION knowledge.generation_changed();
CREATE FUNCTION knowledge.invalidate_scope(target TEXT) RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE knowledge.wiki SET generation=generation+1 WHERE id=target;
    UPDATE knowledge.job SET fence=fence+1,state='unavailable',lease_owner=NULL,lease_until=NULL,failure_code='SOURCE_REVOKED',
      updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE wiki_id=target AND state IN ('queued','running');
  END $$;
CREATE FUNCTION knowledge.origin_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE target TEXT; origin_type TEXT;
  BEGIN
    origin_type=CASE WHEN TG_TABLE_SCHEMA='notes' THEN 'note' ELSE 'document' END;
    FOR target IN SELECT DISTINCT s.wiki_id FROM knowledge.source s JOIN knowledge.wiki w ON w.id=s.wiki_id
      WHERE w.store='pg' AND s.origin_kind=origin_type AND s.origin_id=OLD.id::text ORDER BY s.wiki_id LOOP
      UPDATE knowledge.source SET access_version=access_version+1 WHERE wiki_id=target AND origin_kind=origin_type AND origin_id=OLD.id::text;
      PERFORM knowledge.invalidate_scope(target);
    END LOOP;
    RETURN NULL;
  END $$;
CREATE TRIGGER wiki_origin_invalidation AFTER UPDATE OR DELETE ON project.documents FOR EACH ROW EXECUTE FUNCTION knowledge.origin_invalidation();
CREATE TRIGGER wiki_origin_invalidation AFTER UPDATE OR DELETE ON notes.notes FOR EACH ROW EXECUTE FUNCTION knowledge.origin_invalidation();
CREATE FUNCTION knowledge.source_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.current_revision_id IS NOT NULL AND (OLD.current_revision_id IS DISTINCT FROM NEW.current_revision_id OR OLD.withdrawn_at IS DISTINCT FROM NEW.withdrawn_at) THEN PERFORM knowledge.invalidate_scope(OLD.wiki_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER wiki_source_invalidation AFTER UPDATE ON knowledge.source FOR EACH ROW EXECUTE FUNCTION knowledge.source_invalidation();
CREATE FUNCTION knowledge.authority_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target TEXT; company TEXT; actor TEXT; row_data JSONB;
BEGIN
  row_data=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='users' THEN actor=row_data->>'id';
  ELSIF TG_TABLE_NAME='vaults' THEN actor=row_data->>'owner_id';
  ELSIF TG_TABLE_NAME='companies' THEN company=row_data->>'id';
  ELSIF TG_TABLE_NAME IN ('role_permissions','user_roles') THEN SELECT company_id::text INTO company FROM org.roles WHERE id=(row_data->>'role_id')::bigint;
  ELSE company=row_data->>'company_id'; END IF;
  FOR target IN SELECT id FROM knowledge.wiki w WHERE w.store='pg' AND
    ((company IS NOT NULL AND w.company_id=company) OR (actor IS NOT NULL AND (w.owner_id=actor OR EXISTS(SELECT 1 FROM knowledge.job j WHERE j.wiki_id=w.id AND j.actor_id=actor)))) ORDER BY id LOOP
    -- Reauthorize jobs by stored operation; a grant/write-only change is not
    -- evidence that a reader query lost authority. Generation still wakes SSE.
    UPDATE knowledge.wiki SET generation=generation+1 WHERE id=target;
  END LOOP;
  RETURN NULL;
END $$;
`;
  for(const table of ['org.company_memberships','org.roles','org.role_permissions','org.user_roles','org.company_modules','org.companies','auth.users','notes.vaults','project.projects']) sql+=`CREATE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();\n`;
  return sql;
}
