ALTER TABLE swarm_jobs
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN lease_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN successful_agent_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN automatic_refund_base_units numeric(78, 0) NOT NULL DEFAULT 0;

ALTER TABLE swarm_job_agents ADD COLUMN attempt_count smallint NOT NULL DEFAULT 0;

CREATE TABLE swarm_api_rate_limits (
  key_hash text NOT NULL,
  bucket_start bigint NOT NULL,
  request_count integer NOT NULL,
  PRIMARY KEY (key_hash, bucket_start)
);

CREATE TABLE swarm_payouts (
  job_id char(64) NOT NULL REFERENCES swarm_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('client', 'treasury')),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-fA-F]{40}$'),
  amount_base_units numeric(78, 0) NOT NULL CHECK (amount_base_units > 0),
  status text NOT NULL CHECK (status IN ('prepared', 'broadcast', 'confirmed', 'failed')) DEFAULT 'prepared',
  nonce bigint,
  raw_transaction text,
  transaction_hash text,
  gas_price numeric(78, 0),
  replaced_hashes text[] NOT NULL DEFAULT '{}',
  replacement_count smallint NOT NULL DEFAULT 0,
  broadcast_at timestamptz,
  attempt_count smallint NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, kind),
  UNIQUE (transaction_hash)
);

CREATE UNIQUE INDEX swarm_payouts_nonce_unique
  ON swarm_payouts (nonce) WHERE nonce IS NOT NULL;
CREATE INDEX swarm_jobs_lease_idx
  ON swarm_jobs (status, lease_expires_at, created_at);
