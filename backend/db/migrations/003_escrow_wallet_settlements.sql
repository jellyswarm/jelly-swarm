-- Upgrade installations where the initial JellySwarm schema used generic table names.
-- The public legacy schema also has a jobs table, so only rename it when its columns
-- identify it as the new agent-work schema.
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

ALTER TABLE swarm_jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE swarm_jobs DROP CONSTRAINT IF EXISTS swarm_jobs_status_check;
ALTER TABLE swarm_jobs ADD CONSTRAINT swarm_jobs_status_check
  CHECK (status IN ('payment_pending', 'queued', 'running', 'completed', 'failed', 'settlement_ready', 'payout_pending', 'settlement_pending', 'settled'));

ALTER TABLE swarm_jobs ADD COLUMN IF NOT EXISTS client_payout_tx_hash text UNIQUE;
ALTER TABLE swarm_jobs ADD COLUMN IF NOT EXISTS treasury_payout_tx_hash text UNIQUE;
