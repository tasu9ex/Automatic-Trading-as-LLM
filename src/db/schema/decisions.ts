import { sql } from "drizzle-orm";
import { index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { analystOutputs } from "./analyst-outputs";
import { coins } from "./coins";
import { decisionKindEnum, decisionResultEnum } from "./enums";

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analystId: uuid("analyst_id")
      .notNull()
      .references(() => analystOutputs.id, { onDelete: "cascade" }),
    coinId: uuid("coin_id")
      .notNull()
      .references(() => coins.id, { onDelete: "cascade" }),
    llmModel: text("llm_model").notNull(),
    kind: decisionKindEnum("kind").notNull(),
    result: decisionResultEnum("result").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    /** Exit のみ: 決済比率 % (整数 10-100)。entry は null。100=全決済、<100=部分決済 */
    closePct: numeric("close_pct", { precision: 5, scale: 2 }),
    /** Entry のみ: max_budget の何% を使うか (整数 1-100)。result=buy のとき必須、no/exit は null。 */
    entrySizePct: integer("entry_size_pct"),
    reasoning: text("reasoning"),
    promptVersion: text("prompt_version"),
    langfuseTraceId: text("langfuse_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    coinModelIdx: index("decisions_coin_model_idx").on(table.coinId, table.llmModel),
    createdAtIdx: index("decisions_created_at_idx").on(table.createdAt),
  }),
);

export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
