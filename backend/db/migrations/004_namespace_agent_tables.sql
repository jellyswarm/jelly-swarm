-- Recover databases that already recorded the original generic table migrations.
-- Leave the separate legacy `jobs` table alone unless it has the new schema.
DO $$
DECLARE renamed_jobs boolean := false;
BEGIN
  IF to_regclass('public.swarm_jobs') IS NULL
     AND to_regclass('public.jobs') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'client_address'
     ) THEN
    ALTER TABLE public.jobs RENAME TO swarm_jobs;
    renamed_jobs := true;
  END IF;

  IF renamed_jobs
     AND to_regclass('public.swarm_job_agents') IS NULL
     AND to_regclass('public.job_agents') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'job_agents' AND column_name = 'agent_number'
     ) THEN
    ALTER TABLE public.job_agents RENAME TO swarm_job_agents;
  END IF;
END $$;
