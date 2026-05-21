import { SYSTEM_STATES } from "@/lib/constants/enums";
import { DEFAULT_CYCLE_INTERVAL_MINUTES } from "@/lib/system-control/constants";
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
  /** 判定サイクル間隔（分）。30 / 60 / 240 / 480 / 720 / 1440 のみ。 */
  cycleIntervalMinutes: integer("cycle_interval_minutes")
    .notNull()
    .default(DEFAULT_CYCLE_INTERVAL_MINUTES),
  /** 次回判定サイクルを実行する予定時刻（UTC）。running 時のみ進む。 */
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
  /** 累計 API コスト (USD)。各サイクル完了時に Langfuse 取得値で加算 */
  cumulativeCostUsd: numeric("cumulative_cost_usd", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  /**
   * §17: UI から調整可能なリスクパラメータ。
   * 旧来は src/lib/constants/risk.ts のハードコード定数。DB を唯一のソースに。
   */
  /**
   * 二段リスクモデルの段 1: **1 サイクル内の新規 buy 上限**。
   * cap = `cash × perCoinMaxRatio`。1 回のトランザクションが暴走するのを防ぐ。
   * (旧仕様: per-coin total cap。意味のみ移行、値は据え置きで挙動互換)
   */
  perCoinMaxRatio: numeric("per_coin_max_ratio", { precision: 4, scale: 3 })
    .notNull()
    .default("0.250"),
  /**
   * 二段リスクモデルの段 2: **1 銘柄の総エクスポージャ上限** (= 既存 + 新規)。
   * cap = `equity × perCoinTotalMaxRatio`、headroom = cap - 既存 mtm。
   * 集中度の最終ガード。default 1.0 (= 制限なし) で移行 breaking を防ぐ。
   */
  perCoinTotalMaxRatio: numeric("per_coin_total_max_ratio", { precision: 4, scale: 3 })
    .notNull()
    .default("1.000"),
  /** ポートフォリオ DD がこの比率以上で Kill Switch 発動 (0-1) */
  portfolioDdTrigger: numeric("portfolio_dd_trigger", { precision: 4, scale: 3 })
    .notNull()
    .default("0.500"),
  /** 連続失敗カウンタがこの値に達したら auto-pause */
  autoPauseThreshold: integer("auto_pause_threshold").notNull().default(3),
  /**
   * BB-2: 緊急停止フラグ。各 phase 冒頭で読まれて、true なら phase 内で `EmergencyStopError` を throw → サイクル中断。
   * 通常 pause (現サイクル走り切り + 次サイクル停止) と異なり、サイクル進行中でも即時止める。
   * 解除は「再開」ボタンで false に戻す (state=paused → running の通常フローと同じ動線)。
   */
  emergencyStop: boolean("emergency_stop").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type SystemState = typeof systemState.$inferSelect;
export type NewSystemState = typeof systemState.$inferInsert;
