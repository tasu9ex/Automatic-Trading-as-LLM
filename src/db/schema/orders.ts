import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coins } from "./coins";
import { decisions } from "./decisions";
import { orderSideEnum, orderStatusEnum } from "./enums";

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    coinId: uuid("coin_id")
      .notNull()
      .references(() => coins.id, { onDelete: "cascade" }),
    strategyId: text("strategy_id").notNull(),
    side: orderSideEnum("side").notNull(),
    status: orderStatusEnum("status").notNull(),
    sizeJpy: numeric("size_jpy", { precision: 20, scale: 4 }).notNull(),
    quantity: numeric("quantity", { precision: 30, scale: 10 }).notNull(),
    price: numeric("price", { precision: 20, scale: 4 }).notNull(),
    fee: numeric("fee", { precision: 20, scale: 4 }).notNull().default("0"),
    slippage: numeric("slippage", { precision: 20, scale: 4 }).notNull().default("0"),
    reason: text("reason"),
    /** 実マネー時の TTL (時間)。null = no expiry。ペーパー mode は記録するが評価しない */
    ttlHours: numeric("ttl_hours", { precision: 6, scale: 2 }),
    /** TTL 起点での expire 時刻 (placedAt + ttl)。GMO 側に渡し、超過分は exchange 側で expire */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** 約定確定時刻 (filled / expired / cancelled / rejected いずれも) */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    modelCoinIdx: index("orders_model_coin_idx").on(table.strategyId, table.coinId),
    createdAtIdx: index("orders_created_at_idx").on(table.createdAt),
  }),
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
