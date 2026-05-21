ALTER TABLE "system_state" ADD COLUMN "per_coin_max_ratio" numeric(4, 3) DEFAULT '0.250' NOT NULL;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "portfolio_dd_trigger" numeric(4, 3) DEFAULT '0.500' NOT NULL;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "auto_pause_threshold" integer DEFAULT 3 NOT NULL;