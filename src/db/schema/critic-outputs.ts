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
    allocationProposal: jsonb("allocation_proposal").notNull(),
    adjustments: jsonb("adjustments"),
    reasoning: text("reasoning"),
    promptVersion: text("prompt_version"),
    langfuseTraceId: text("langfuse_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    cycleModelIdx: index("critic_outputs_cycle_model_idx").on(table.cycleId, table.llmModel),
  }),
);

export type CriticOutput = typeof criticOutputs.$inferSelect;
export type NewCriticOutput = typeof criticOutputs.$inferInsert;
