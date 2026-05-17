import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coins } from "./coins";
import { orderSideEnum } from "./enums";
import { orders } from "./orders";
import { positions } from "./positions";

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    coinId: uuid("coin_id")
      .notNull()
      .references(() => coins.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    side: orderSideEnum("side").notNull(),
    quantity: numeric("quantity", { precision: 30, scale: 10 }).notNull(),
    price: numeric("price", { precision: 20, scale: 4 }).notNull(),
    fee: numeric("fee", { precision: 20, scale: 4 }).notNull().default("0"),
    pnlJpy: numeric("pnl_jpy", { precision: 20, scale: 4 }),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    modelCoinIdx: index("trades_model_coin_idx").on(table.model, table.coinId),
    executedAtIdx: index("trades_executed_at_idx").on(table.executedAt),
  }),
);

export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
