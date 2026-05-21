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
    /**
     * P-5: cycle に紐づく event は payload->>'cycleId' で JSONB 検索していたが seq scan になっていた。
     * 直接カラムにして index を貼る。書き込み側 (failure.ts / judgment.ts / emergency-stop.ts) で同時に埋める。
     * 既存行は payload から backfill する migration を別途流す (生成 migration の手元編集が必要)。
     */
    cycleId: uuid("cycle_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    kindOccurredAtIdx: index("system_events_kind_occurred_at_idx").on(table.kind, table.occurredAt),
    cycleIdIdx: index("system_events_cycle_id_idx").on(table.cycleId),
  }),
);

export type SystemEvent = typeof systemEvents.$inferSelect;
export type NewSystemEvent = typeof systemEvents.$inferInsert;
