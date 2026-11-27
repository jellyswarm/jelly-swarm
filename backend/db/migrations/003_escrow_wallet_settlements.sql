ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('payment_pending', 'queued', 'running', 'completed', 'failed', 'settlement_ready', 'payout_pending', 'settlement_pending', 'settled'));

ALTER TABLE jobs ADD COLUMN client_payout_tx_hash text UNIQUE;
ALTER TABLE jobs ADD COLUMN treasury_payout_tx_hash text UNIQUE;
