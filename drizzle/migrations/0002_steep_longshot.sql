ALTER TYPE "public"."system_event_kind" ADD VALUE 'cycle_aborted' BEFORE 'human_intervention';--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "slippage" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "fee";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "slippage";