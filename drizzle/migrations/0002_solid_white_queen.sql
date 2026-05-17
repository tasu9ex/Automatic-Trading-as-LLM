ALTER TYPE "public"."pending_order_kind" ADD VALUE 'stop_limit_primary';--> statement-breakpoint
ALTER TYPE "public"."pending_order_kind" ADD VALUE 'stop_market_entry';--> statement-breakpoint
ALTER TYPE "public"."pending_order_kind" ADD VALUE 'stop_market_peak';--> statement-breakpoint
ALTER TABLE "pending_orders" ADD COLUMN "limit_price" numeric(20, 4);