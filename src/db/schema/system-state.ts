import { sql } from "drizzle-orm";
import { integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const systemStateEnum = pgEnum("system_state_value", [
  "stopped",
  "running",
  "paused",
  "killed",
]);

/**
 * シングルトン的に 1 行だけ持つ。id="singleton" で固定。
 */
export const systemState = pgTable("system_state", {
  id: text("id").primaryKey().default("singleton"),
  state: systemStateEnum("state").notNull().default("stopped"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  killReason: text("kill_reason"),
  killedAt: timestamp("killed_at", { withTimezone: true }),
  lastCycleId: uuid("last_cycle_id"),
  lastCycleAt: timestamp("last_cycle_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type SystemState = typeof systemState.$inferSelect;
export type NewSystemState = typeof systemState.$inferInsert;
