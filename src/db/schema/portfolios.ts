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
  /**
   * High Water Mark: equity (= cash + Σ positions の mtm) の過去最大値。
   * Kill Switch の DD 計算で base に使う (= 最大 DD from peak)。
   * 入金時は HWM += 入金額、出金時は HWM -= 出金額 で capital movement を控除し、
   * "performance による peak" だけを追う (capital-injection-adjusted HWM)。
   * 初期値は initialCashJpy。
   */
  highWaterMarkJpy: numeric("high_water_mark_jpy", { precision: 20, scale: 4 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type Portfolio = typeof portfolios.$inferSelect;
export type NewPortfolio = typeof portfolios.$inferInsert;
