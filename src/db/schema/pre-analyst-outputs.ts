import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { marketSnapshots } from "./market-snapshots";

export const preAnalystOutputs = pgTable(
  "pre_analyst_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => marketSnapshots.id, { onDelete: "cascade" }),
    llmModel: text("llm_model").notNull(),
    summary: text("summary").notNull(),
    skipFlag: boolean("skip_flag").notNull().default(false),
    reasoning: text("reasoning"),
    promptVersion: text("prompt_version"),
    langfuseTraceId: text("langfuse_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    snapshotIdx: index("pre_analyst_outputs_snapshot_idx").on(table.snapshotId),
  }),
);

export type PreAnalystOutput = typeof preAnalystOutputs.$inferSelect;
export type NewPreAnalystOutput = typeof preAnalystOutputs.$inferInsert;
