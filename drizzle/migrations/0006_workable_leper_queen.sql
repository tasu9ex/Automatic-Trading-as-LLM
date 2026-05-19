ALTER TYPE "public"."order_status" ADD VALUE 'placed' BEFORE 'filled';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'expired' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'cancelled' BEFORE 'rejected';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ttl_hours" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "completed_at" timestamp with time zone;