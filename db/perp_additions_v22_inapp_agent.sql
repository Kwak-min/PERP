BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id TEXT PRIMARY KEY, company_id BIGINT NOT NULL REFERENCES org.companies(id),
  actor_id BIGINT NOT NULL REFERENCES auth.users(id), conversation_id TEXT,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  response_json JSONB, error_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id,actor_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS public.agent_operations (
  id TEXT PRIMARY KEY, company_id BIGINT NOT NULL REFERENCES org.companies(id),
  actor_id BIGINT NOT NULL REFERENCES auth.users(id),
  run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  tool TEXT NOT NULL, input_json JSONB NOT NULL, input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('preview','confirmed','executed','cancelled','failed')),
  version INTEGER NOT NULL DEFAULT 1, approval_id TEXT,
  execution_key TEXT, execution_version INTEGER, result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id,actor_id,run_id,tool_call_id)
);
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS knowledge_mode TEXT NOT NULL DEFAULT 'personal' CHECK(knowledge_mode IN ('personal','company'));
ALTER TABLE public.agent_operations ADD COLUMN IF NOT EXISTS knowledge_mode TEXT NOT NULL DEFAULT 'personal' CHECK(knowledge_mode IN ('personal','company'));
CREATE OR REPLACE FUNCTION public.inapp_agent_mode_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.knowledge_mode IS DISTINCT FROM NEW.knowledge_mode THEN
    RAISE EXCEPTION 'agent knowledge mode is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_runs_mode_immutable ON public.agent_runs;
CREATE TRIGGER agent_runs_mode_immutable BEFORE UPDATE OF knowledge_mode ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.inapp_agent_mode_immutable();
DROP TRIGGER IF EXISTS agent_operations_mode_immutable ON public.agent_operations;
CREATE TRIGGER agent_operations_mode_immutable BEFORE UPDATE OF knowledge_mode ON public.agent_operations
  FOR EACH ROW EXECUTE FUNCTION public.inapp_agent_mode_immutable();
COMMIT;
