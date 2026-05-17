import { sql } from "drizzle-orm";
import { boolean, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coins } from "./coins";
import { pendingOrderActorEnum, pendingOrderKindEnum } from "./enums";
import { positions } from "./positions";

export const pendingOrders = pgTable(
  "pending_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    coinId: uuid("coin_id")
      .notNull()
      .references(() => coins.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    kind: pendingOrderKindEnum("kind").notNull(),
    triggerPrice: numeric("trigger_price", { precision: 20, scale: 4 }).notNull(),
    createdBy: pendingOrderActorEnum("created_by").notNull().default("code"),
    active: boolean("active").notNull().default(true),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    activeIdx: index("pending_orders_active_idx").on(table.active, table.coinId),
    positionIdx: index("pending_orders_position_idx").on(table.positionId),
  }),
);

export type PendingOrder = typeof pendingOrders.$inferSelect;
export type NewPendingOrder = typeof pendingOrders.$inferInsert;
