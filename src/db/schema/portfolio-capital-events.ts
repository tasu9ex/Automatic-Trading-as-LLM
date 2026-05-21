import { sql } from "drizzle-orm";
import { index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const capitalEventKindEnum = pgEnum("capital_event_kind", ["deposit", "withdrawal"]);

/**
 * 入金 / 出金 履歴。
 *
 * Capital-injection-adjusted HWM のため、外部資金の出入りを HWM 計算で控除する。
 * 履歴はここに残し、portfolios.cashJpy / highWaterMarkJpy / initialCashJpy はイベント時に同時更新。
 *
 * 現状は CLI スクリプト (`scripts/dev/capital.ts`) からのみ書く想定。
 * 将来 UI フォームで出すときはこのテーブルが lookup ソースになる。
 */
export const portfolioCapitalEvents = pgTable(
  "portfolio_capital_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: text("strategy_id").notNull(),
    kind: capitalEventKindEnum("kind").notNull(),
    amountJpy: numeric("amount_jpy", { precision: 20, scale: 4 }).notNull(),
    note: text("note"),
    /** イベント時点の equity スナップショット (deposit/withdrawal 直前) */
    equityBeforeJpy: numeric("equity_before_jpy", { precision: 20, scale: 4 }),
    /** イベント時点の HWM スナップショット (調整前) */
    hwmBeforeJpy: numeric("hwm_before_jpy", { precision: 20, scale: 4 }),
    metadata: jsonb("metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    strategyOccurredIdx: index("portfolio_capital_events_strategy_occurred_idx").on(
      table.strategyId,
      table.occurredAt,
    ),
  }),
);

export type PortfolioCapitalEvent = typeof portfolioCapitalEvents.$inferSelect;
export type NewPortfolioCapitalEvent = typeof portfolioCapitalEvents.$inferInsert;
