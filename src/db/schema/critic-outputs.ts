import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { criticDecisionEnum } from "./enums";

export const criticOutputs = pgTable(
  "critic_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cycleId: uuid("cycle_id").notNull(),
    llmModel: text("llm_model").notNull(),
    decision: criticDecisionEnum("decision").notNull(),
    /**
     * Critic に渡した実行計画 (Exit dry-run + Allocator + Clipper 適用済)。
     * 構造: ExecutionPlan ({ exits, entries, projectedCashJpy, currentPositions,
     *                       plannedPositions, clipperChanges })
     */
    executionPlan: jsonb("execution_plan").notNull(),
    /**
     * Critic 適用後のポジション見込み (modify のみ)。symbol → jpy。
     * approve のときは null (executionPlan.plannedPositions と同値なので冗長保存しない)。
     * veto のときも null (全銘柄キャンセル = currentPositions と同値)。
     */
    modifiedPositions: jsonb("modified_positions"),
    adjustments: jsonb("adjustments"),
    reasoning: text("reasoning"),
    promptVersion: text("prompt_version"),
    langfuseTraceId: text("langfuse_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    cycleModelIdx: index("critic_outputs_cycle_model_idx").on(table.cycleId, table.llmModel),
    // P-4: `cyclesToday` の COUNT(*) WHERE created_at >= jstTodayStart で範囲スキャンが発生する。
    // 件数が増えると seq scan が支配的になるので index を貼っておく。
    createdAtIdx: index("critic_outputs_created_at_idx").on(table.createdAt),
  }),
);

export type CriticOutput = typeof criticOutputs.$inferSelect;
export type NewCriticOutput = typeof criticOutputs.$inferInsert;
