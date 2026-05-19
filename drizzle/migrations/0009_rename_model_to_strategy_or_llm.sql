-- Rename `model` columns for clarity:
--   * 戦略 ID として使ってたテーブル: model → strategy_id
--   * LLM model 名として使ってたテーブル: model → llm_model

ALTER TABLE "portfolios"        RENAME COLUMN "model" TO "strategy_id";--> statement-breakpoint
ALTER TABLE "positions"         RENAME COLUMN "model" TO "strategy_id";--> statement-breakpoint
ALTER TABLE "orders"            RENAME COLUMN "model" TO "strategy_id";--> statement-breakpoint
ALTER TABLE "trades"            RENAME COLUMN "model" TO "strategy_id";--> statement-breakpoint
ALTER TABLE "pending_orders"    RENAME COLUMN "model" TO "strategy_id";--> statement-breakpoint
ALTER TABLE "system_events"     RENAME COLUMN "model" TO "strategy_id";--> statement-breakpoint

ALTER TABLE "analyst_outputs"     RENAME COLUMN "model" TO "llm_model";--> statement-breakpoint
ALTER TABLE "pre_analyst_outputs" RENAME COLUMN "model" TO "llm_model";--> statement-breakpoint
ALTER TABLE "decisions"           RENAME COLUMN "model" TO "llm_model";--> statement-breakpoint
ALTER TABLE "critic_outputs"      RENAME COLUMN "model" TO "llm_model";
