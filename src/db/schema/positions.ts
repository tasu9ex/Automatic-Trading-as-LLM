import { sql } from "drizzle-orm";
import { index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coins } from "./coins";
import { positionStatusEnum } from "./enums";

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: text("strategy_id").notNull(),
    coinId: uuid("coin_id")
      .notNull()
      .references(() => coins.id, { onDelete: "cascade" }),
    status: positionStatusEnum("status").notNull().default("open"),
    quantity: numeric("quantity", { precision: 30, scale: 10 }).notNull(),
    avgEntryPrice: numeric("avg_entry_price", { precision: 20, scale: 4 }).notNull(),
    peakPrice: numeric("peak_price", { precision: 20, scale: 4 }).notNull(),
    troughPrice: numeric("trough_price", { precision: 20, scale: 4 }).notNull(),
    entryReason: text("entry_reason"),
    /** Entry 時の予想保有期間 (ピラミ時は最新で上書き、Exit 入力に reference として渡す) */
    entryExpectedHoldingDaysMin: integer("entry_expected_holding_days_min"),
    entryExpectedHoldingDaysMax: integer("entry_expected_holding_days_max"),
    /** Entry 時の緩い目標価格 (anchor 禁止材料) */
    entryTargetPriceJpy: numeric("entry_target_price_jpy", { precision: 20, scale: 4 }),
    /** Entry 時の Exit 条件(narrative、参考) */
    entryExitCondition: text("entry_exit_condition"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    realizedPnlJpy: numeric("realized_pnl_jpy", { precision: 20, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    modelCoinStatusIdx: index("positions_model_coin_status_idx").on(
      table.strategyId,
      table.coinId,
      table.status,
    ),
  }),
);

export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
