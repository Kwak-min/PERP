-- Additive, idempotent, reversible schema additions (v25).
-- Covers: project.tasks/task_checklist_items, asset.assets/reservations,
--         org.approval_requests + org.approval_steps, calendar.events,
--         ai.agent_memory, public.recurrence_rules tenant isolation,
--         project.meeting_decisions. No DML / backfill. Single transaction.
BEGIN;

-- ============================================================
-- A. Column additions (all ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- project.tasks
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  ADD COLUMN IF NOT EXISTS estimate_hours numeric(6,2),
  ADD COLUMN IF NOT EXISTS parent_id bigint;

-- FK (no IF NOT EXISTS on ADD CONSTRAINT -> guard via pg_constraint)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_parent_id_fkey' AND conrelid = 'project.tasks'::regclass) THEN
    ALTER TABLE project.tasks ADD CONSTRAINT tasks_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES project.tasks(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON project.tasks(parent_id);

-- project.task_checklist_items
ALTER TABLE project.task_checklist_items
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT false;

-- asset.assets
ALTER TABLE asset.assets
  ADD COLUMN IF NOT EXISTS quantity int NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  ADD COLUMN IF NOT EXISTS threshold int NOT NULL DEFAULT 0 CHECK (threshold >= 0),
  ADD COLUMN IF NOT EXISTS qr_code text;

-- asset.reservations
ALTER TABLE asset.reservations
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

-- org.approval_requests
ALTER TABLE org.approval_requests
  ADD COLUMN IF NOT EXISTS amount numeric(14,2);

-- calendar.events
ALTER TABLE calendar.events
  ADD COLUMN IF NOT EXISTS meeting_url text;

-- ai.agent_memory (value sets undecided -> no CHECK, open text)
ALTER TABLE ai.agent_memory
  ADD COLUMN IF NOT EXISTS sensitivity text,
  ADD COLUMN IF NOT EXISTS usage_scope text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- ============================================================
-- C. recurrence reuse: tenant isolation + tasks/events reference
-- ============================================================

-- public.recurrence_rules company_id (nullable; legacy reservation module unused; 0 rows)
ALTER TABLE public.recurrence_rules
  ADD COLUMN IF NOT EXISTS company_id bigint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurrence_rules_company_fkey' AND conrelid = 'public.recurrence_rules'::regclass) THEN
    ALTER TABLE public.recurrence_rules ADD CONSTRAINT recurrence_rules_company_fkey
      FOREIGN KEY (company_id) REFERENCES org.companies(id) ON DELETE CASCADE;
  END IF;
END $$;

-- tasks / events reference recurrence_rules(int4 id) -> FK column type integer
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS recurrence_rule_id integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_recurrence_fkey' AND conrelid = 'project.tasks'::regclass) THEN
    ALTER TABLE project.tasks ADD CONSTRAINT tasks_recurrence_fkey
      FOREIGN KEY (recurrence_rule_id) REFERENCES public.recurrence_rules(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE calendar.events
  ADD COLUMN IF NOT EXISTS recurrence_rule_id integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_recurrence_fkey' AND conrelid = 'calendar.events'::regclass) THEN
    ALTER TABLE calendar.events ADD CONSTRAINT events_recurrence_fkey
      FOREIGN KEY (recurrence_rule_id) REFERENCES public.recurrence_rules(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- B. New tables
-- ============================================================

CREATE TABLE IF NOT EXISTS org.approval_steps (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL,
  approval_id bigint NOT NULL,
  ordinal     int    NOT NULL,
  approver_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  mode        text   NOT NULL DEFAULT 'sequential' CHECK (mode IN ('sequential','parallel')),
  kind        text,
  status      text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','held')),
  comment     text,
  decided_at  timestamptz,
  delegate_of bigint REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_steps_request_fkey FOREIGN KEY (company_id, approval_id)
    REFERENCES org.approval_requests(company_id, id) ON DELETE CASCADE,
  CONSTRAINT approval_steps_ordinal_uq UNIQUE (approval_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_approval_steps_approval ON org.approval_steps(approval_id, ordinal);

CREATE TABLE IF NOT EXISTS project.meeting_decisions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES org.companies(id) ON DELETE CASCADE,
  minute_id  bigint NOT NULL REFERENCES project.meeting_minutes(id) ON DELETE CASCADE,
  content    text   NOT NULL,
  owner_id   bigint REFERENCES auth.users(id) ON DELETE SET NULL,
  due_on     date,
  status     text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meeting_decisions_minute ON project.meeting_decisions(minute_id);

COMMIT;
