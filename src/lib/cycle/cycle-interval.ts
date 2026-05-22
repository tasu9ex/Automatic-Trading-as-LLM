/**
 * cycleIntervalMinutes を LLM が読みやすい日本語に整形する。
 *
 *   30   -> "30 分"
 *   60   -> "1 時間"
 *   720  -> "12 時間"
 *   1440 -> "1 日"
 */
export function formatCycleInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} 分`;
  if (minutes < 1440) {
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours} 時間` : `${hours.toFixed(1)} 時間`;
  }
  const days = minutes / 1440;
  return Number.isInteger(days) ? `${days} 日` : `${days.toFixed(1)} 日`;
}
