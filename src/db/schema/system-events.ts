import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { systemEventKindEnum, systemEventSeverityEnum } from "./enums";

export const systemEvents = pgTable(
  "system_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: text("strategy_id"),
    kind: systemEventKindEnum("kind").notNull(),
    severity: systemEventSeverityEnum("severity").notNull().default("info"),
    message: text("message").notNull(),
    payload: jsonb("payload"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    kindOccurredAtIdx: index("system_events_kind_occurred_at_idx").on(table.kind, table.occurredAt),
  }),
);

export type SystemEvent = typeof systemEvents.$inferSelect;
export type NewSystemEvent = typeof systemEvents.$inferInsert;
