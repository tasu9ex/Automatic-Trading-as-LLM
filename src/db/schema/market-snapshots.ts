import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coins } from "./coins";

export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cycleId: uuid("cycle_id").notNull(),
    coinId: uuid("coin_id")
      .notNull()
      .references(() => coins.id, { onDelete: "cascade" }),
    ohlcv1m: jsonb("ohlcv_1m").notNull(),
    ohlcv1h: jsonb("ohlcv_1h").notNull(),
    /** Tier 0 で取得した 1d 足。Tier 1/2 prompt の長期トレンド用 */
    ohlcv1d: jsonb("ohlcv_1d"),
    /** Orderbook + 直近約定から計算した micro market 指標 (Tier 2 用) */
    micro: jsonb("micro"),
    perplexitySummary: text("perplexity_summary"),
    perplexityCitations: jsonb("perplexity_citations").$type<string[]>().notNull().default([]),
    grokSummary: text("grok_summary"),
    grokCitations: jsonb("grok_citations").$type<string[]>().notNull().default([]),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    cycleCoinIdx: index("market_snapshots_cycle_coin_idx").on(table.cycleId, table.coinId),
    fetchedAtIdx: index("market_snapshots_fetched_at_idx").on(table.fetchedAt),
  }),
);

export type MarketSnapshot = typeof marketSnapshots.$inferSelect;
export type NewMarketSnapshot = typeof marketSnapshots.$inferInsert;
