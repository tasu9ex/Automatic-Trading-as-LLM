/**
 * 判定サイクルの実行間隔（分）。UI プリセットと DB 制約で共用。
 * 30min / 1hour / 4hour / 8hour / 12hour / 1day の 6 段階。
 * Kline 取得 interval と 1:1 対応 (cycleMinutesToKlineInterval)。
 */
export const CYCLE_INTERVAL_MINUTES = [30, 60, 240, 480, 720, 1440] as const;
export type CycleIntervalMinutes = (typeof CYCLE_INTERVAL_MINUTES)[number];

export const DEFAULT_CYCLE_INTERVAL_MINUTES: CycleIntervalMinutes = 1440;

export function isCycleIntervalMinutes(n: number): n is CycleIntervalMinutes {
  return (CYCLE_INTERVAL_MINUTES as readonly number[]).includes(n);
}

/**
 * バケット境界は UTC 起点 (computeNextScheduledAt 参照)。JST 換算は +9h。
 *   30min  → 毎時 :00 / :30
 *   1hour  → 毎時 :00
 *   4hour  → UTC 00/04/08/12/16/20 = JST 09/13/17/21/01/05
 *   8hour  → UTC 00/08/16 = JST 09/17/01
 *   12hour → UTC 00/12 = JST 09/21
 *   1day   → UTC 00:00 = JST 09:00
 */
export function formatIntervalLabel(minutes: CycleIntervalMinutes): string {
  if (minutes === 30) return "30分ごと";
  if (minutes === 60) return "1時間ごと";
  if (minutes === 240) return "4時間ごと (JST 01/05/09/13/17/21)";
  if (minutes === 480) return "8時間ごと (JST 01/09/17)";
  if (minutes === 720) return "12時間ごと (JST 09/21)";
  return "24時間ごと (JST 09:00)";
}

/** GMO Kline の interval 種別。 */
export type KlineInterval =
  | "1min"
  | "5min"
  | "15min"
  | "30min"
  | "1hour"
  | "4hour"
  | "8hour"
  | "12hour"
  | "1day";

/**
 * サイクル間隔（分）→ Kline interval。
 * 1:1 マッピング。LLM に渡す bar は「サイクル interval × 200 本」のみ。
 */
export function cycleMinutesToKlineInterval(minutes: CycleIntervalMinutes): KlineInterval {
  switch (minutes) {
    case 30:
      return "30min";
    case 60:
      return "1hour";
    case 240:
      return "4hour";
    case 480:
      return "8hour";
    case 720:
      return "12hour";
    case 1440:
      return "1day";
  }
}
