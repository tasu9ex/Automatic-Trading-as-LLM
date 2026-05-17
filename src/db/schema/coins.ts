import { sql } from "drizzle-orm";
import { boolean, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const coins = pgTable("coins", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: text("symbol").notNull().unique(),
  name: text("name").notNull(),
  minOrderSize: numeric("min_order_size", { precision: 30, scale: 10 }).notNull(),
  makerFeeRate: numeric("maker_fee_rate", { precision: 6, scale: 5 }).notNull(),
  takerFeeRate: numeric("taker_fee_rate", { precision: 6, scale: 5 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type Coin = typeof coins.$inferSelect;
export type NewCoin = typeof coins.$inferInsert;
