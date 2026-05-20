ALTER TABLE "decisions" ADD COLUMN "entry_expected_holding_days_min" numeric(6, 0);--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "entry_expected_holding_days_max" numeric(6, 0);--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "entry_target_price_jpy" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "entry_exit_condition" text;