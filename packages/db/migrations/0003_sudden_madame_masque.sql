ALTER TABLE "disputes" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "id" uuid PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "referrals" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "id" uuid PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;