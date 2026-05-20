/** 判定サイクルの実行間隔（時間）。UI プリセットと DB 制約で共用。 */
export const CYCLE_INTERVAL_HOURS = [1, 3, 6, 24] as const;
export type CycleIntervalHours = (typeof CYCLE_INTERVAL_HOURS)[number];

export const DEFAULT_CYCLE_INTERVAL_HOURS: CycleIntervalHours = 24;

export function isCycleIntervalHours(n: number): n is CycleIntervalHours {
  return (CYCLE_INTERVAL_HOURS as readonly number[]).includes(n);
}

/**
 * バケット境界は UTC 起点 (computeNextScheduledAt 参照)。JST 換算は +9h。
 *   1h  → 毎時 :00
 *   3h  → UTC 00/03/06/09/12/15/18/21 = JST 09/12/15/18/21/00/03/06
 *   6h  → UTC 00/06/12/18 = JST 09/15/21/03
 *   24h → UTC 00:00 = JST 09:00
 */
export function formatIntervalLabel(hours: CycleIntervalHours): string {
  if (hours === 1) return "1時間ごと";
  if (hours === 3) return "3時間ごと (JST 00/03/06/09/12/15/18/21)";
  if (hours === 6) return "6時間ごと (JST 03/09/15/21)";
  return "24時間ごと (JST 09:00)";
}
