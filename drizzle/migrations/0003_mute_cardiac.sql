ALTER TABLE "positions" ADD COLUMN "entry_expected_holding_days_min" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "entry_expected_holding_days_max" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "entry_target_price_jpy" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "entry_exit_condition" text;