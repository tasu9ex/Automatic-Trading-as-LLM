CREATE TYPE "public"."capital_event_kind" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TABLE "portfolio_capital_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" text NOT NULL,
	"kind" "capital_event_kind" NOT NULL,
	"amount_jpy" numeric(20, 4) NOT NULL,
	"note" text,
	"equity_before_jpy" numeric(20, 4),
	"hwm_before_jpy" numeric(20, 4),
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- HWM: 本番データは価値なし前提で reset 想定。既存行は initial_cash_jpy で埋めるだけの簡易対応。
-- (seed が走った後の初期値は seed.ts で initialCashJpy と同期する)
ALTER TABLE "portfolios" ADD COLUMN "high_water_mark_jpy" numeric(20, 4) NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE "portfolios" SET "high_water_mark_jpy" = "initial_cash_jpy";--> statement-breakpoint
CREATE INDEX "portfolio_capital_events_strategy_occurred_idx" ON "portfolio_capital_events" USING btree ("strategy_id","occurred_at");