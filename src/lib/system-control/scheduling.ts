import type { CycleIntervalHours } from "./constants";

/**
 * `from` より後の、UTC エポック起点の間隔バケット境界を返す。
 * - 24h → 毎日 UTC 00:00 (= JST 09:00)
 * - 6h  → UTC 0 / 6 / 12 / 18
 * - 1h  → 毎時 0 分
 */
export function computeNextScheduledAt(from: Date, intervalHours: CycleIntervalHours): Date {
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const t = from.getTime();
  const bucket = Math.floor(t / intervalMs);
  const candidate = (bucket + 1) * intervalMs;
  if (candidate > t) {
    return new Date(candidate);
  }
  return new Date(candidate + intervalMs);
}

export function isScheduleDue(now: Date, nextScheduledAt: Date | null | undefined): boolean {
  if (!nextScheduledAt) return false;
  return now.getTime() >= nextScheduledAt.getTime();
}
