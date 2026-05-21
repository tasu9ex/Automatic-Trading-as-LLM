import { sql } from "drizzle-orm";
import { boolean, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const coins = pgTable("coins", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: text("symbol").notNull().unique(),
  name: text("name").notNull(),
  minOrderSize: numeric("min_order_size", { precision: 30, scale: 10 }).notNull(),
  makerFeeRate: numeric("maker_fee_rate", { precision: 6, scale: 5 }).notNull(),
  takerFeeRate: numeric("taker_fee_rate", { precision: 6, scale: 5 }).notNull(),
  // 全 GMO 銘柄を coins テーブルに同期する仕様 (sync-coins) を採用したので、新規取り込み分は
  // default disabled に。enable はユーザーが UI から明示的に有効化する。seed で 5 銘柄だけ true。
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type Coin = typeof coins.$inferSelect;
export type NewCoin = typeof coins.$inferInsert;
