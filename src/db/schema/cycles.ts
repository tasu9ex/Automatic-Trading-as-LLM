import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * 1 サイクルの実行記録。preflight で 1 行 insert、finalize で completed_at を埋める。
 * coin_ids はサイクル開始時の `coins.enabled=true` を凍結したスナップショット。
 * 各 Tier phase はこの配列を参照することで、cycle 進行中の coins.enabled トグルに
 * 影響されず安全に動く (変更は次サイクルから反映)。
 */
export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: text("strategy_id").notNull(),
    coinIds: jsonb("coin_ids").$type<string[]>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().default(sql`now()`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    startedAtIdx: index("cycles_started_at_idx").on(table.startedAt),
  }),
);

export type Cycle = typeof cycles.$inferSelect;
export type NewCycle = typeof cycles.$inferInsert;
