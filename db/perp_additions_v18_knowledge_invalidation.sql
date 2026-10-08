BEGIN;
CREATE OR REPLACE FUNCTION knowledge.generation_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM pg_notify('orbitflow_wiki_invalidated',json_build_object('store','pg','wiki_id',NEW.id,'generation',NEW.generation)::text);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER wiki_generation_changed AFTER UPDATE OF generation ON knowledge.wiki FOR EACH ROW WHEN (OLD.generation IS DISTINCT FROM NEW.generation) EXECUTE FUNCTION knowledge.generation_changed();
CREATE OR REPLACE FUNCTION knowledge.invalidate_scope(target TEXT) RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE knowledge.wiki SET generation=generation+1 WHERE id=target;
    UPDATE knowledge.job SET fence=fence+1,state='unavailable',lease_owner=NULL,lease_until=NULL,failure_code='SOURCE_REVOKED',
      updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE wiki_id=target AND state IN ('queued','running');
  END $$;
CREATE OR REPLACE FUNCTION knowledge.origin_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE TRIGGER wiki_origin_invalidation AFTER UPDATE OR DELETE ON project.documents FOR EACH ROW EXECUTE FUNCTION knowledge.origin_invalidation();
CREATE OR REPLACE TRIGGER wiki_origin_invalidation AFTER UPDATE OR DELETE ON notes.notes FOR EACH ROW EXECUTE FUNCTION knowledge.origin_invalidation();
CREATE OR REPLACE FUNCTION knowledge.source_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.current_revision_id IS NOT NULL AND (OLD.current_revision_id IS DISTINCT FROM NEW.current_revision_id OR OLD.withdrawn_at IS DISTINCT FROM NEW.withdrawn_at) THEN PERFORM knowledge.invalidate_scope(OLD.wiki_id); END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER wiki_source_invalidation AFTER UPDATE ON knowledge.source FOR EACH ROW EXECUTE FUNCTION knowledge.source_invalidation();
CREATE OR REPLACE FUNCTION knowledge.authority_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON org.company_memberships FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON org.roles FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON org.role_permissions FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON org.user_roles FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON org.company_modules FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON org.companies FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON notes.vaults FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
CREATE OR REPLACE TRIGGER wiki_authority_invalidation AFTER INSERT OR UPDATE OR DELETE ON project.projects FOR EACH ROW EXECUTE FUNCTION knowledge.authority_invalidation();
COMMIT;
