/** Pure SL trigger 判定ロジック (DB / 外部 API に依存しない、テスト容易性のため分離)。 */

export interface Bar {
  openTime: number;
  low: number;
  high: number;
  close: number;
}

export interface FiredSignal {
  kind: string;
  marketPrice: number;
  forced: boolean;
}

/**
 * Stop-Limit を優先、約定可能性なければ Stop-Market 系で判定。
 * 戻り値: 約定する order の executeExit 引数情報 (なければ null)。
 *
 * 約定判定 (1m bar):
 *   - stop_limit_primary: bar.low <= trigger AND 同 bar 以降の bar.high >= limit
 *     → limit_price で約定、スリッページなし
 *   - stop_market_entry / stop_market_peak: bar.low <= trigger
 *     → trigger 価格で約定、forced=true (スリッページ控除は executor 側)
 */
export function decideFiredOrder(
  triggered: Array<{ kind: string; triggerPrice: string; limitPrice: string | null }>,
  bars: Bar[],
  recentLow: number,
): FiredSignal | null {
  const stopLimit = triggered.find((o) => o.kind === "stop_limit_primary");
  if (stopLimit) {
    const trigger = Number(stopLimit.triggerPrice);
    const limit = Number(stopLimit.limitPrice ?? 0);
    const triggerFiredIdx = bars.findIndex((b) => b.low <= trigger);
    if (triggerFiredIdx >= 0 && limit > 0) {
      const remainingBars = bars.slice(triggerFiredIdx);
      if (remainingBars.some((b) => b.high >= limit)) {
        return { kind: "stop_limit_primary", marketPrice: limit, forced: false };
      }
    }
  }

  const stopMarketEntry = triggered.find((o) => o.kind === "stop_market_entry");
  if (stopMarketEntry && recentLow <= Number(stopMarketEntry.triggerPrice)) {
    return {
      kind: "stop_market_entry",
      marketPrice: Number(stopMarketEntry.triggerPrice),
      forced: true,
    };
  }

  const stopMarketPeak = triggered.find((o) => o.kind === "stop_market_peak");
  if (stopMarketPeak && recentLow <= Number(stopMarketPeak.triggerPrice)) {
    return {
      kind: "stop_market_peak",
      marketPrice: Number(stopMarketPeak.triggerPrice),
      forced: true,
    };
  }

  return null;
}
