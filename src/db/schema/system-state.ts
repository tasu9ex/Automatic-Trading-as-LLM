import { SYSTEM_STATES } from "@/lib/constants/enums";
import { DEFAULT_CYCLE_INTERVAL_HOURS } from "@/lib/system-control/constants";
import { sql } from "drizzle-orm";
import { integer, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const systemStateEnum = pgEnum("system_state_value", SYSTEM_STATES);

/**
 * シングルトン的に 1 行だけ持つ。id="singleton" で固定。
 */
export const systemState = pgTable("system_state", {
  id: text("id").primaryKey().default("singleton"),
  state: systemStateEnum("state").notNull().default("stopped"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /**
   * 直近失敗の分類 ("transient" / "permanent" / "quota")。
   * consecutiveFailures はこれと同じ kind が続く間だけカウントする (異種が来たらリセット)。
   * 成功サイクル後は null。
   */
  lastFailureKind: text("last_failure_kind"),
  killReason: text("kill_reason"),
  killedAt: timestamp("killed_at", { withTimezone: true }),
  lastCycleId: uuid("last_cycle_id"),
  lastCycleAt: timestamp("last_cycle_at", { withTimezone: true }),
  /** 判定サイクル間隔（時間）。1 / 6 / 24 のみ。 */
  cycleIntervalHours: integer("cycle_interval_hours")
    .notNull()
    .default(DEFAULT_CYCLE_INTERVAL_HOURS),
  /** 次回判定サイクルを実行する予定時刻（UTC）。running 時のみ進む。 */
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
  /** 累計 API コスト (USD)。各サイクル完了時に Langfuse 取得値で加算 */
  cumulativeCostUsd: numeric("cumulative_cost_usd", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type SystemState = typeof systemState.$inferSelect;
export type NewSystemState = typeof systemState.$inferInsert;
