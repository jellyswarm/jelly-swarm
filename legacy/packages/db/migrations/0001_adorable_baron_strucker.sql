ALTER TABLE "jobs" ADD COLUMN "volume_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "job" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "extra" jsonb NOT NULL;