ALTER TABLE "critic_outputs" ADD COLUMN "confidence" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "decisions" DROP COLUMN "entry_expected_holding_days_min";--> statement-breakpoint
ALTER TABLE "decisions" DROP COLUMN "entry_expected_holding_days_max";--> statement-breakpoint
ALTER TABLE "decisions" DROP COLUMN "entry_target_price_jpy";--> statement-breakpoint
ALTER TABLE "decisions" DROP COLUMN "entry_exit_condition";--> statement-breakpoint
ALTER TABLE "positions" DROP COLUMN "entry_expected_holding_days_min";--> statement-breakpoint
ALTER TABLE "positions" DROP COLUMN "entry_expected_holding_days_max";--> statement-breakpoint
ALTER TABLE "positions" DROP COLUMN "entry_target_price_jpy";--> statement-breakpoint
ALTER TABLE "positions" DROP COLUMN "entry_exit_condition";