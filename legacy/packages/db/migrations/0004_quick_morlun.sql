ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT "disputes_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "referral_codes" DROP CONSTRAINT "referral_codes_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "referrals" DROP CONSTRAINT "referrals_referrer_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "referrals" DROP CONSTRAINT "referrals_referee_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "referrals" DROP CONSTRAINT "referrals_not_self";
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ALTER COLUMN "account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "disputes" ALTER COLUMN "account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "quotes" ALTER COLUMN "account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "referral_codes" ALTER COLUMN "account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "referrals" ALTER COLUMN "referrer" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "referrals" ALTER COLUMN "referee" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "share_links" ALTER COLUMN "account_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_not_self" CHECK ("referrals"."referrer" <> "referrals"."referee");