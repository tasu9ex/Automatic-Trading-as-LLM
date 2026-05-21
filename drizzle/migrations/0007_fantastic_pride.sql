ALTER TABLE "market_snapshots" ALTER COLUMN "ohlcv_1m" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "ohlcv_primary" jsonb;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "ohlcv_long" jsonb;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "primary_interval" text;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "long_interval" text;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD COLUMN "ticker" jsonb;