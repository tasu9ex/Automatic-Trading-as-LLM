import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coins } from "./coins";
import { positionStatusEnum } from "./enums";

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    model: text("model").notNull(),
    coinId: uuid("coin_id")
      .notNull()
      .references(() => coins.id, { onDelete: "cascade" }),
    status: positionStatusEnum("status").notNull().default("open"),
    quantity: numeric("quantity", { precision: 30, scale: 10 }).notNull(),
    avgEntryPrice: numeric("avg_entry_price", { precision: 20, scale: 4 }).notNull(),
    peakPrice: numeric("peak_price", { precision: 20, scale: 4 }).notNull(),
    troughPrice: numeric("trough_price", { precision: 20, scale: 4 }).notNull(),
    entryReason: text("entry_reason"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    realizedPnlJpy: numeric("realized_pnl_jpy", { precision: 20, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    modelCoinStatusIdx: index("positions_model_coin_status_idx").on(
      table.model,
      table.coinId,
      table.status,
    ),
  }),
);

export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
