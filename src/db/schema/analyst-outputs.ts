import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { marketSnapshots } from "./market-snapshots";
import { preAnalystOutputs } from "./pre-analyst-outputs";

export const analystOutputs = pgTable(
  "analyst_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => marketSnapshots.id, { onDelete: "cascade" }),
    preAnalystId: uuid("pre_analyst_id").references(() => preAnalystOutputs.id, {
      onDelete: "set null",
    }),
    llmModel: text("llm_model").notNull(),
    fundamental: jsonb("fundamental").notNull(),
    sentiment: jsonb("sentiment").notNull(),
    technical: jsonb("technical").notNull(),
    synthesis: jsonb("synthesis").notNull(),
    promptVersion: text("prompt_version"),
    langfuseTraceId: text("langfuse_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    snapshotModelIdx: index("analyst_outputs_snapshot_model_idx").on(
      table.snapshotId,
      table.llmModel,
    ),
  }),
);

export type AnalystOutput = typeof analystOutputs.$inferSelect;
export type NewAnalystOutput = typeof analystOutputs.$inferInsert;
