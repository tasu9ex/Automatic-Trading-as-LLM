/**
 * `now - periodHours` を UTC で日付に丸めて返す共通ユーティリティ。
 * Perplexity / Grok の検索期間 filter で使う。
 * 日付精度なので実窓は最大 +24h ゆるくなる (プロンプトの自然文と併用する前提)。
 */
export function periodStartDateUtc(
  periodHours: number,
  nowMs: number = Date.now(),
): { y: number; m: number; d: number } {
  const dt = new Date(nowMs - periodHours * 3600_000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

/** Perplexity search_after_date_filter (MM/DD/YYYY) */
export function periodAsMdy(periodHours: number, nowMs: number = Date.now()): string {
  const { y, m, d } = periodStartDateUtc(periodHours, nowMs);
  return `${pad(m)}/${pad(d)}/${y}`;
}

/** Grok web_search / x_search の from_date (YYYY-MM-DD) */
export function periodAsIsoDate(periodHours: number, nowMs: number = Date.now()): string {
  const { y, m, d } = periodStartDateUtc(periodHours, nowMs);
  return `${y}-${pad(m)}-${pad(d)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
