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
    /** @deprecated §32 で ohlcv_primary に統一 (新規行は null)。 */
    ohlcv1m: jsonb("ohlcv_1m"),
    /** @deprecated §21 で常時 [] 固定だったレガシー列。次の clean-up で drop 予定。 */
    ohlcv1h: jsonb("ohlcv_1h").notNull(),
    /** @deprecated §32 で ohlcv_long に統一 (新規行は null)。 */
    ohlcv1d: jsonb("ohlcv_1d"),
    /**
     * §32: 動的 TF。サイクル間隔ベースで GMO interval を選択して保存。
     *   1h cycle  → primary="1hour" / long="1day"
     *   3h, 6h    → primary="4hour" / long="1day"
     *   24h cycle → primary="1day"  / long=null
     */
    ohlcvPrimary: jsonb("ohlcv_primary"),
    ohlcvLong: jsonb("ohlcv_long"),
    primaryInterval: text("primary_interval"),
    longInterval: text("long_interval"),
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
