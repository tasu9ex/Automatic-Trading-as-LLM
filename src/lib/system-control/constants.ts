/** 判定サイクルの実行間隔（時間）。UI プリセットと DB 制約で共用。 */
export const CYCLE_INTERVAL_HOURS = [1, 6, 24] as const;
export type CycleIntervalHours = (typeof CYCLE_INTERVAL_HOURS)[number];

export const DEFAULT_CYCLE_INTERVAL_HOURS: CycleIntervalHours = 24;

export function isCycleIntervalHours(n: number): n is CycleIntervalHours {
  return (CYCLE_INTERVAL_HOURS as readonly number[]).includes(n);
}

export function formatIntervalLabel(hours: CycleIntervalHours): string {
  if (hours === 1) return "1時間";
  if (hours === 6) return "6時間";
  return "24時間 (JST 9:00)";
}
