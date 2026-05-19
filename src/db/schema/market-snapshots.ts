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
