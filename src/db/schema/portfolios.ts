import { sql } from "drizzle-orm";
import { boolean, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Shadow trading の各仮想ポートフォリオ。
 * strategy_id (例: "trial-5") が portfolio identifier として全テーブルに紐づく。
 */
export const portfolios = pgTable("portfolios", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyId: text("strategy_id").notNull().unique(),
  description: text("description"),
  initialCashJpy: numeric("initial_cash_jpy", { precision: 20, scale: 4 }).notNull(),
  cashJpy: numeric("cash_jpy", { precision: 20, scale: 4 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type Portfolio = typeof portfolios.$inferSelect;
export type NewPortfolio = typeof portfolios.$inferInsert;
