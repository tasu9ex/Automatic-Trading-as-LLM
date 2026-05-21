/**
 * 動的リスクパラメータの取得 (§17)。
 *
 * 旧来は src/lib/constants/risk.ts のハードコード定数で、変更には deploy が必要だった。
 * §17 以降は system_state から読む。UI (ダッシュボード) で変更すると即時反映される。
 *
 * - PER_COIN_MAX_RATIO / PORTFOLIO_DD_TRIGGER / AUTO_PAUSE_THRESHOLD は UI 経由で可変
 * - PER_COIN_MIN_JPY / TOTAL_MAX_RATIO はコード定数のまま (UI 露出しない設計判断)
 */

import { db } from "@/db/client";
import { systemState } from "@/db/schema";
import {
  AUTO_PAUSE_THRESHOLD as DEFAULT_AUTO_PAUSE_THRESHOLD,
  PER_COIN_MAX_RATIO as DEFAULT_PER_COIN_MAX_RATIO,
  PORTFOLIO_DD_TRIGGER as DEFAULT_PORTFOLIO_DD_TRIGGER,
  PER_COIN_MIN_JPY,
  TOTAL_MAX_RATIO,
} from "@/lib/constants/risk";
import { eq } from "drizzle-orm";

export { PER_COIN_MIN_JPY, TOTAL_MAX_RATIO };

export interface RiskParams {
  /** 1 銘柄あたりの最大配分比率 (例: 0.25 = 25%) */
  perCoinMaxRatio: number;
  /** Kill Switch を発動する DD 比率 (例: 0.5 = -50%) */
  portfolioDdTrigger: number;
  /** 連続失敗カウンタがこの値で auto-pause */
  autoPauseThreshold: number;
}

/**
 * system_state から動的パラメータを読む。
 * 行が存在しない / 値が異常 (range out) なら定数のデフォルトにフォールバック。
 */
export async function getRiskParams(): Promise<RiskParams> {
  const row = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];

  const perCoinMaxRatio = clampRatio(
    Number(row?.perCoinMaxRatio ?? DEFAULT_PER_COIN_MAX_RATIO),
    DEFAULT_PER_COIN_MAX_RATIO,
  );
  const portfolioDdTrigger = clampRatio(
    Number(row?.portfolioDdTrigger ?? DEFAULT_PORTFOLIO_DD_TRIGGER),
    DEFAULT_PORTFOLIO_DD_TRIGGER,
  );
  const autoPauseThreshold = clampInt(
    row?.autoPauseThreshold ?? DEFAULT_AUTO_PAUSE_THRESHOLD,
    1,
    20,
    DEFAULT_AUTO_PAUSE_THRESHOLD,
  );

  return { perCoinMaxRatio, portfolioDdTrigger, autoPauseThreshold };
}

function clampRatio(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0 || v > 1) return fallback;
  return v;
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const i = Math.round(v);
  if (i < min || i > max) return fallback;
  return i;
}
