/**
 * Critic に渡すシステム健全性スナップ (§33)。
 *
 * 決定論的に集計され、Critic LLM の判断補助 (データ不全銘柄を modify で弾く等) に使われる。
 * ハルシネーション抑制のため、Critic は trading 判断のみで supervisor LLM は導入しない設計。
 */

import { z } from "zod";

export const DataFreshnessLevelSchema = z.enum(["fresh", "stale", "no_data"]);
export type DataFreshnessLevel = z.infer<typeof DataFreshnessLevelSchema>;

export const SystemHealthSchema = z.object({
  /** 直近の連続失敗カウンタ。0 = 直前のサイクル成功。 */
  consecutiveFailures: z.number().int().min(0),
  /** 直近失敗の分類。成功直後 or quota の場合は null。 */
  lastFailureKind: z.enum(["transient", "permanent", "quota"]).nullable(),
  /** システム状態。Critic が呼ばれる時点では running のはず (paused / killed は別経路で skip)。 */
  killSwitchState: z.enum(["running", "paused", "killed", "stopped"]),
  /**
   * 銘柄ごとのデータ取得状況。
   *   fresh   : ticker.last > 0 かつ snapshot.fetchedAt が直近 1h 以内
   *   stale   : ticker.last > 0 だが snapshot が 1h 以上前
   *   no_data : ticker.last = 0 (1m kline 空 / 取得失敗)
   */
  dataFreshness: z.record(z.string(), DataFreshnessLevelSchema),
  /**
   * 今サイクルで Entry executor が skip する見込みの銘柄 (price <= 0 等)。
   * Critic はこれらを adjustments.buys で 0 円に上書きすることを推奨される。
   */
  knownSkipRisks: z.array(z.string()),
});
export type SystemHealth = z.infer<typeof SystemHealthSchema>;
