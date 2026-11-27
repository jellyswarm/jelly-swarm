CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"banned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"account_id" uuid NOT NULL,
	"wallet_address" text NOT NULL,
	"chain" text NOT NULL,
	"grant_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "burns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"chain" text NOT NULL,
	"job_keys_root" text NOT NULL,
	"job_keys" text[] NOT NULL,
	"kind" text NOT NULL,
	"stable_in_usd6" bigint NOT NULL,
	"token_burned" text,
	"reason" text,
	"tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"delta_usd6" bigint NOT NULL,
	"reason" text NOT NULL,
	"job_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"pow_penalty_bits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_key" text NOT NULL,
	"row_idx" integer[] NOT NULL,
	"fee_usd6" bigint NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"evidence" jsonb,
	"refund_bps" integer[],
	"tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "disputes_max_rows" CHECK (cardinality("disputes"."row_idx") between 1 and 25)
);
--> statement-breakpoint
CREATE TABLE "email_logins" (
	"email_hmac" "bytea" PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_grants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"device_id" text NOT NULL,
	"ip_prefix" text NOT NULL,
	"asn" integer,
	"job_key" text,
	"quote_usd6" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"job_key" text NOT NULL,
	"seq" bigint NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	CONSTRAINT "job_events_job_key_seq_pk" PRIMARY KEY("job_key","seq")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"job_key" text PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"onchain_job_id" text,
	"quote_id" uuid NOT NULL,
	"account_id" uuid,
	"product" text NOT NULL,
	"tier" text NOT NULL,
	"lane" text NOT NULL,
	"state" text DEFAULT 'quoted' NOT NULL,
	"funding_route" text,
	"funder" text,
	"refund_to" text,
	"wallet_job" boolean DEFAULT false NOT NULL,
	"budget_usd6" bigint NOT NULL,
	"row_count" integer NOT NULL,
	"passed_count" integer,
	"tools_usd6" bigint,
	"cost_usd6" bigint DEFAULT 0 NOT NULL,
	"receipts_root" text,
	"receipts_count" integer,
	"receipts_head" text,
	"rows_root" text,
	"verdict_sig" text,
	"fund_tx" text,
	"seal_tx" text,
	"settle_tx" text,
	"finalize_tx" text,
	"meter_bucket" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"funded_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"release_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	CONSTRAINT "jobs_passed_le_rows" CHECK ("jobs"."passed_count" is null or "jobs"."passed_count" between 0 and "jobs"."row_count")
);
--> statement-breakpoint
CREATE TABLE "meter_posts" (
	"day" date NOT NULL,
	"product" text NOT NULL,
	"chain" text NOT NULL,
	"real_usd6" bigint NOT NULL,
	"external_small_usd6" bigint NOT NULL,
	"incentive_usd6" bigint NOT NULL,
	"internal_usd6" bigint NOT NULL,
	"test_usd6" bigint NOT NULL,
	"jobs_root" text NOT NULL,
	"tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meter_posts_day_product_chain_pk" PRIMARY KEY("day","product","chain")
);
--> statement-breakpoint
CREATE TABLE "node_audits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operator_id" bigint NOT NULL,
	"call_leaf" text,
	"kind" text NOT NULL,
	"passed" boolean NOT NULL,
	"score" jsonb,
	"evidence_hash" text,
	"slash_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" bigint PRIMARY KEY NOT NULL,
	"payout" text NOT NULL,
	"route" text NOT NULL,
	"endpoint_hash" text,
	"attest_hash" text,
	"is_studio" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"strikes" integer DEFAULT 0 NOT NULL,
	"passing_canaries" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exit_requested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"credential_id" "bytea" PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_epochs" (
	"epoch" integer NOT NULL,
	"chain" text NOT NULL,
	"root" text NOT NULL,
	"total_usd6" bigint NOT NULL,
	"tx" text,
	"leaves" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_epochs_epoch_chain_pk" PRIMARY KEY("epoch","chain")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"product" text NOT NULL,
	"tier" text NOT NULL,
	"chain" text NOT NULL,
	"units" integer NOT NULL,
	"max_agents" integer NOT NULL,
	"unit_usd6" bigint NOT NULL,
	"base_usd6" bigint NOT NULL,
	"tools_cap_usd6" bigint NOT NULL,
	"est_cost_usd6" bigint NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quotes_max_agents_cap" CHECK ("quotes"."max_agents" between 1 and 247),
	CONSTRAINT "quotes_units_positive" CHECK ("quotes"."units" > 0),
	CONSTRAINT "quotes_amounts_nonneg" CHECK ("quotes"."unit_usd6" >= 0 and "quotes"."base_usd6" >= 0 and "quotes"."tools_cap_usd6" >= 0 and "quotes"."est_cost_usd6" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"job_key" text NOT NULL,
	"step_idx" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"role" smallint NOT NULL,
	"row_idx" integer,
	"prev_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"tool_calls_hash" text NOT NULL,
	"model_id" text NOT NULL,
	"host" text NOT NULL,
	"cost_micros" bigint NOT NULL,
	"output_hash" text NOT NULL,
	"attestation_ref" text NOT NULL,
	"leaf" text NOT NULL,
	"signature" text NOT NULL,
	"node_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_job_key_step_idx_pk" PRIMARY KEY("job_key","step_idx"),
	CONSTRAINT "receipts_step_nonneg" CHECK ("receipts"."step_idx" >= 0)
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ref_code" text NOT NULL,
	"referrer" uuid NOT NULL,
	"referee" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"block_reason" text,
	"qualifying_job_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_not_self" CHECK ("referrals"."referrer" <> "referrals"."referee")
);
--> statement-breakpoint
CREATE TABLE "rows" (
	"job_key" text NOT NULL,
	"row_idx" integer NOT NULL,
	"item" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"cells" jsonb,
	"operator_id" bigint,
	"host" text,
	"fail_reason" text,
	"row_receipts_hash" text,
	"tools_usd6" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rows_job_key_row_idx_pk" PRIMARY KEY("job_key","row_idx"),
	CONSTRAINT "rows_idx_nonneg" CHECK ("rows"."row_idx" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"slug" text PRIMARY KEY NOT NULL,
	"job_key" text NOT NULL,
	"account_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"template_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_wallets" (
	"address" text NOT NULL,
	"chain" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_wallets_address_chain_pk" PRIMARY KEY("address","chain")
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"spec_template" jsonb NOT NULL,
	"pricebook_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_versions_template_id_version_pk" PRIMARY KEY("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"product" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"safety_class" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tg_links" (
	"tg_user_id" bigint PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_ledger" (
	"job_key" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"product" text NOT NULL,
	"chain" text NOT NULL,
	"funder" text NOT NULL,
	"gross_usd6" bigint NOT NULL,
	"bucket" text NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text NOT NULL,
	"chain" text NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_address_chain_pk" PRIMARY KEY("address","chain")
);
--> statement-breakpoint
CREATE TABLE "x402_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"payer" text NOT NULL,
	"pay_to" text NOT NULL,
	"amount_usd6" bigint NOT NULL,
	"nonce" text NOT NULL,
	"mode" text NOT NULL,
	"job_key" text,
	"state" text NOT NULL,
	"tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_job_key_jobs_job_key_fk" FOREIGN KEY ("job_key") REFERENCES "public"."jobs"("job_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logins" ADD CONSTRAINT "email_logins_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_grants" ADD CONSTRAINT "free_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_grants" ADD CONSTRAINT "free_grants_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_audits" ADD CONSTRAINT "node_audits_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_job_key_jobs_job_key_fk" FOREIGN KEY ("job_key") REFERENCES "public"."jobs"("job_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_accounts_id_fk" FOREIGN KEY ("referrer") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_accounts_id_fk" FOREIGN KEY ("referee") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_job_key_jobs_job_key_fk" FOREIGN KEY ("job_key") REFERENCES "public"."jobs"("job_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_job_key_jobs_job_key_fk" FOREIGN KEY ("job_key") REFERENCES "public"."jobs"("job_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_links" ADD CONSTRAINT "tg_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_ledger" ADD CONSTRAINT "volume_ledger_job_key_jobs_job_key_fk" FOREIGN KEY ("job_key") REFERENCES "public"."jobs"("job_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_account_idx" ON "credit_ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_job_idx" ON "disputes" USING btree ("job_key");--> statement-breakpoint
CREATE UNIQUE INDEX "free_grants_device_idx" ON "free_grants" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "free_grants_prefix_idx" ON "free_grants" USING btree ("ip_prefix","created_at");--> statement-breakpoint
CREATE INDEX "jobs_account_idx" ON "jobs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_state_idx" ON "jobs" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_chain_onchain_idx" ON "jobs" USING btree ("chain","onchain_job_id");--> statement-breakpoint
CREATE INDEX "node_audits_operator_idx" ON "node_audits" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "passkeys_account_idx" ON "passkeys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "quotes_account_idx" ON "quotes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "receipts_job_row_idx" ON "receipts" USING btree ("job_key","row_idx");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referee_idx" ON "referrals" USING btree ("referee");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer","created_at");--> statement-breakpoint
CREATE INDEX "rows_job_state_idx" ON "rows" USING btree ("job_key","state");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "share_links_job_idx" ON "share_links" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "volume_ledger_day_idx" ON "volume_ledger" USING btree ("day","product","chain");--> statement-breakpoint
CREATE INDEX "wallets_account_idx" ON "wallets" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "x402_nonce_idx" ON "x402_payments" USING btree ("network","nonce");--> statement-breakpoint
CREATE INDEX "x402_job_idx" ON "x402_payments" USING btree ("job_key");