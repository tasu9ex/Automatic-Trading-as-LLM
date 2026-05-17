CREATE TYPE "public"."critic_decision" AS ENUM('approve', 'veto', 'modify');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('entry', 'exit');--> statement-breakpoint
CREATE TYPE "public"."decision_result" AS ENUM('buy', 'no', 'hold', 'close');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('filled', 'rejected', 'clipped');--> statement-breakpoint
CREATE TYPE "public"."pending_order_actor" AS ENUM('code', 'llm', 'human');--> statement-breakpoint
CREATE TYPE "public"."pending_order_kind" AS ENUM('stop_loss_entry_based', 'stop_loss_peak_based');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."system_event_kind" AS ENUM('system_started', 'system_paused', 'system_resumed', 'kill_switch_triggered', 'critic_veto', 'critic_modify', 'llm_failure', 'human_intervention', 'price_monitor_triggered', 'data_fetch_failed');--> statement-breakpoint
CREATE TYPE "public"."system_event_severity" AS ENUM('info', 'warning', 'error', 'critical');--> statement-breakpoint
CREATE TYPE "public"."system_state_value" AS ENUM('stopped', 'running', 'paused', 'killed');--> statement-breakpoint
CREATE TABLE "analyst_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"pre_analyst_id" uuid,
	"model" text NOT NULL,
	"fundamental" jsonb NOT NULL,
	"sentiment" jsonb NOT NULL,
	"technical" jsonb NOT NULL,
	"synthesis" jsonb NOT NULL,
	"prompt_version" text,
	"langfuse_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"min_order_size" numeric(30, 10) NOT NULL,
	"maker_fee_rate" numeric(6, 5) NOT NULL,
	"taker_fee_rate" numeric(6, 5) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coins_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "critic_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"model" text NOT NULL,
	"decision" "critic_decision" NOT NULL,
	"allocation_proposal" jsonb NOT NULL,
	"adjustments" jsonb,
	"reasoning" text,
	"prompt_version" text,
	"langfuse_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analyst_id" uuid NOT NULL,
	"coin_id" uuid NOT NULL,
	"model" text NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"result" "decision_result" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"reasoning" text,
	"prompt_version" text,
	"langfuse_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"coin_id" uuid NOT NULL,
	"ohlcv_1m" jsonb NOT NULL,
	"ohlcv_1h" jsonb NOT NULL,
	"perplexity_summary" text,
	"grok_summary" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid,
	"coin_id" uuid NOT NULL,
	"model" text NOT NULL,
	"side" "order_side" NOT NULL,
	"status" "order_status" NOT NULL,
	"size_jpy" numeric(20, 4) NOT NULL,
	"quantity" numeric(30, 10) NOT NULL,
	"price" numeric(20, 4) NOT NULL,
	"fee" numeric(20, 4) DEFAULT '0' NOT NULL,
	"slippage" numeric(20, 4) DEFAULT '0' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"coin_id" uuid NOT NULL,
	"model" text NOT NULL,
	"kind" "pending_order_kind" NOT NULL,
	"trigger_price" numeric(20, 4) NOT NULL,
	"created_by" "pending_order_actor" DEFAULT 'code' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"triggered_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"description" text,
	"initial_cash_jpy" numeric(20, 4) NOT NULL,
	"cash_jpy" numeric(20, 4) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolios_model_unique" UNIQUE("model")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"coin_id" uuid NOT NULL,
	"status" "position_status" DEFAULT 'open' NOT NULL,
	"quantity" numeric(30, 10) NOT NULL,
	"avg_entry_price" numeric(20, 4) NOT NULL,
	"peak_price" numeric(20, 4) NOT NULL,
	"trough_price" numeric(20, 4) NOT NULL,
	"entry_reason" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"realized_pnl_jpy" numeric(20, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pre_analyst_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"model" text NOT NULL,
	"summary" text NOT NULL,
	"relevance_score" numeric(4, 3) NOT NULL,
	"skip_flag" boolean DEFAULT false NOT NULL,
	"reasoning" text,
	"prompt_version" text,
	"langfuse_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text,
	"kind" "system_event_kind" NOT NULL,
	"severity" "system_event_severity" DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"state" "system_state_value" DEFAULT 'stopped' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"kill_reason" text,
	"killed_at" timestamp with time zone,
	"last_cycle_id" uuid,
	"last_cycle_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"coin_id" uuid NOT NULL,
	"model" text NOT NULL,
	"side" "order_side" NOT NULL,
	"quantity" numeric(30, 10) NOT NULL,
	"price" numeric(20, 4) NOT NULL,
	"fee" numeric(20, 4) DEFAULT '0' NOT NULL,
	"pnl_jpy" numeric(20, 4),
	"executed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyst_outputs" ADD CONSTRAINT "analyst_outputs_snapshot_id_market_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."market_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_outputs" ADD CONSTRAINT "analyst_outputs_pre_analyst_id_pre_analyst_outputs_id_fk" FOREIGN KEY ("pre_analyst_id") REFERENCES "public"."pre_analyst_outputs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_analyst_id_analyst_outputs_id_fk" FOREIGN KEY ("analyst_id") REFERENCES "public"."analyst_outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_coin_id_coins_id_fk" FOREIGN KEY ("coin_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_coin_id_coins_id_fk" FOREIGN KEY ("coin_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coin_id_coins_id_fk" FOREIGN KEY ("coin_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_coin_id_coins_id_fk" FOREIGN KEY ("coin_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_coin_id_coins_id_fk" FOREIGN KEY ("coin_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_analyst_outputs" ADD CONSTRAINT "pre_analyst_outputs_snapshot_id_market_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."market_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_coin_id_coins_id_fk" FOREIGN KEY ("coin_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyst_outputs_snapshot_model_idx" ON "analyst_outputs" USING btree ("snapshot_id","model");--> statement-breakpoint
CREATE INDEX "critic_outputs_cycle_model_idx" ON "critic_outputs" USING btree ("cycle_id","model");--> statement-breakpoint
CREATE INDEX "decisions_coin_model_idx" ON "decisions" USING btree ("coin_id","model");--> statement-breakpoint
CREATE INDEX "decisions_created_at_idx" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "market_snapshots_cycle_coin_idx" ON "market_snapshots" USING btree ("cycle_id","coin_id");--> statement-breakpoint
CREATE INDEX "market_snapshots_fetched_at_idx" ON "market_snapshots" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "orders_model_coin_idx" ON "orders" USING btree ("model","coin_id");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pending_orders_active_idx" ON "pending_orders" USING btree ("active","coin_id");--> statement-breakpoint
CREATE INDEX "pending_orders_position_idx" ON "pending_orders" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "positions_model_coin_status_idx" ON "positions" USING btree ("model","coin_id","status");--> statement-breakpoint
CREATE INDEX "pre_analyst_outputs_snapshot_idx" ON "pre_analyst_outputs" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "system_events_kind_occurred_at_idx" ON "system_events" USING btree ("kind","occurred_at");--> statement-breakpoint
CREATE INDEX "trades_model_coin_idx" ON "trades" USING btree ("model","coin_id");--> statement-breakpoint
CREATE INDEX "trades_executed_at_idx" ON "trades" USING btree ("executed_at");