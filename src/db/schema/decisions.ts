import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    model: text("model").notNull(),
    kind: decisionKindEnum("kind").notNull(),
    result: decisionResultEnum("result").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    reasoning: text("reasoning"),
    promptVersion: text("prompt_version"),
    langfuseTraceId: text("langfuse_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    coinModelIdx: index("decisions_coin_model_idx").on(table.coinId, table.model),
    createdAtIdx: index("decisions_created_at_idx").on(table.createdAt),
  }),
);

export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
