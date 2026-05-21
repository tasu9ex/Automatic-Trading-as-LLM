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
    /**
     * Kline (OHLCV) と GMO interval 名。
     * 「サイクル interval × 200 本」のみ保存 (旧 primary/long の二段は廃止)。
     */
    ohlcv: jsonb("ohlcv"),
    klineInterval: text("kline_interval"),
    /** GMO ticker をそのまま保存 (loadSnapshot の擬似再構成を廃止、§31 根治) */
    ticker: jsonb("ticker"),
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
