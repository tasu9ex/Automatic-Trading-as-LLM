import type { OHLCBar } from "@/lib/clients/gmo";
import { formatJpy } from "@/lib/format/jpy";

/**
 * OHLCV を LLM 用テキストに整形。価格は **bitFlyer JPY 建て** であることを ¥ 接頭で明示。
 * 報道由来の USD 価格と混同してスケール誤読 ($12.4k 等) するのを防ぐため。
 */
export function formatOhlcvBars(
  bars: OHLCBar[],
  opts: {
    maxRows: number;
    /** "date": YYYY-MM-DD / "iso": フル ISO8601 */
    datePrecision: "date" | "iso";
    /** 行頭に `[<interval>]:` を挟む場合 (pre-analyst) */
    intervalLabel?: string;
    /** 空配列時のプレースホルダ */
    emptyText: string;
  },
): string {
  if (bars.length === 0) return opts.emptyText;
  const recent = bars.slice(-opts.maxRows);
  return recent.map((bar) => formatRow(bar, opts)).join("\n");
}

function formatRow(
  bar: OHLCBar,
  opts: { datePrecision: "date" | "iso"; intervalLabel?: string },
): string {
  const iso = new Date(Number(bar.openTime)).toISOString();
  const d = opts.datePrecision === "date" ? iso.slice(0, 10) : iso;
  const prefix = opts.intervalLabel ? `${d} [${opts.intervalLabel}]` : d;
  const jpy = (n: string | number) => formatJpy(Number(n));
  return `${prefix}: O=${jpy(bar.open)} H=${jpy(bar.high)} L=${jpy(bar.low)} C=${jpy(bar.close)} V=${bar.volume}`;
}
