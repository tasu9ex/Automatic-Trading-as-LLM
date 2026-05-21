import type { CycleIntervalMinutes } from "./constants";

/**
 * `from` より後の、UTC エポック起点の間隔バケット境界を返す。
 * - 1440min (1day) → 毎日 UTC 00:00 (= JST 09:00)
 * - 720min (12h)   → UTC 0 / 12
 * - 480min (8h)    → UTC 0 / 8 / 16
 * - 240min (4h)    → UTC 0 / 4 / 8 / 12 / 16 / 20
 * - 60min (1h)     → 毎時 0 分
 * - 30min          → 毎時 0 / 30 分
 */
export function computeNextScheduledAt(from: Date, intervalMinutes: CycleIntervalMinutes): Date {
  const intervalMs = intervalMinutes * 60 * 1000;
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
