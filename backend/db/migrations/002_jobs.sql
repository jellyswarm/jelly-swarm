CREATE TABLE jobs (
  id char(64) PRIMARY KEY,
  client_address text NOT NULL CHECK (client_address ~ '^0x[0-9a-fA-F]{40}$'),
  task text NOT NULL,
  agent_count smallint NOT NULL CHECK (agent_count BETWEEN 1 AND 247),
  amount_base_units numeric(78, 0) NOT NULL CHECK (amount_base_units > 0),
  status text NOT NULL CHECK (status IN ('payment_pending', 'queued', 'running', 'completed', 'failed', 'settlement_ready', 'settled')),
  payment_tx_hash text UNIQUE,
  result jsonb,
  error_code text,
  settlement_share_bps smallint,
  settlement_deadline numeric(78, 0),
  settlement_signature text,
  settlement_tx_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_status_created_idx ON jobs (status, created_at);

CREATE TABLE job_agents (
  job_id char(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_number smallint NOT NULL CHECK (agent_number BETWEEN 1 AND 247),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  output text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, agent_number)
);
