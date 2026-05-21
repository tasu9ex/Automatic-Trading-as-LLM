import { db } from "@/db/client";
import { coins, pendingOrders, positions, systemEvents } from "@/db/schema";
import { getKlines } from "@/lib/clients/gmo";
import { executeExit } from "@/lib/executor";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { and, eq } from "drizzle-orm";

const logger = createLogger("price-monitor");

/** ピーク比 SL の trailing ratio (-50%) */
const STOP_MARKET_PEAK_RATIO = 0.5;

import { type Bar, decideFiredOrder } from "./decide";

function toBar(raw: {
  openTime: number | string;
  low: string;
  high: string;
  close: string;
}): Bar {
  return {
    openTime: Number(raw.openTime),
    low: Number(raw.low),
    high: Number(raw.high),
    close: Number(raw.close),
  };
}

function yyyymmdd(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

/**
 * since から now までの 1分足バーを取得 (JST 日跨ぎ対応)。
 */
async function fetchBarsSince(symbolJpy: string, since: Date): Promise<Bar[]> {
  const now = new Date();
  const dates = new Set<string>([yyyymmdd(since), yyyymmdd(now)]);
  const all: Bar[] = [];
  for (const date of dates) {
    try {
      const klines = await getKlines(symbolJpy, "1min", date);
      for (const k of klines) all.push(toBar(k));
    } catch (err) {
      logger.warn({ err, symbol: symbolJpy, date }, "kline fetch failed");
    }
  }
  return all
    .filter((b) => b.openTime > since.getTime() && b.openTime <= now.getTime())
    .sort((a, b) => a.openTime - b.openTime);
}

export interface PriceMonitorInput {
  /** この時刻以降の 1m バーを処理対象にする。未指定なら直近 1時間。 */
  since?: Date;
}

/**
 * since 以降の 1分足を全て確認し、逆指値タッチ判定 + ピーク/トラフ更新。
 *
 * 約定判定 (1m bar):
 *   - stop_limit_primary: bar.low <= trigger AND 同 bar 以降の bar.high >= limit
 *     → limit_price で約定、スリッページなし
 *   - stop_market_entry / stop_market_peak: bar.low <= trigger
 *     → trigger × (1 - 0.003) で約定、スリッページ 0.3% 控除 (executor 側で計算)
 *
 * judgment cycle の冒頭で呼ぶ用途を想定。
 * 前回サイクル時刻 (system_state.lastCycleAt) を since として渡す。
 *
 * 実マネー運用時 (Phase E) は GMO 取引所側で逆指値が動くので、この処理は不要。
 */
export async function runPriceMonitor(input: PriceMonitorInput = {}): Promise<void> {
  // REAL mode では GMO 側で逆指値が動くため、ローカル replay は不要かつ二重決済リスク
  if ((process.env.PAPER_TRADE ?? "true").toLowerCase() === "false") {
    logger.info("REAL mode: price-monitor skipped (GMO handles SL)");
    return;
  }
  const since = input.since ?? new Date(Date.now() - 60 * 60_000);

  const openPositions = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(eq(positions.status, "open"));

  if (openPositions.length === 0) {
    logger.debug("No open positions");
    return;
  }

  for (const { position, coin } of openPositions) {
    const symbolJpy = `${coin.symbol}_JPY`;
    const bars = await fetchBarsSince(symbolJpy, since);
    if (bars.length === 0) continue;

    const recentHigh = Math.max(...bars.map((b) => b.high));
    const recentLow = Math.min(...bars.map((b) => b.low));

    // ピーク・トラフ更新
    const peak = Math.max(Number(position.peakPrice), recentHigh);
    const trough = Math.min(Number(position.troughPrice), recentLow);
    if (peak !== Number(position.peakPrice) || trough !== Number(position.troughPrice)) {
      await db
        .update(positions)
        .set({ peakPrice: peak.toFixed(4), troughPrice: trough.toFixed(4), updatedAt: new Date() })
        .where(eq(positions.id, position.id));
    }

    const triggered = await db
      .select()
      .from(pendingOrders)
      .where(and(eq(pendingOrders.positionId, position.id), eq(pendingOrders.active, true)));

    // peak trailing 更新 (約定判定前)
    for (const order of triggered) {
      if (order.kind === "stop_market_peak") {
        const newTrigger = peak * STOP_MARKET_PEAK_RATIO;
        if (newTrigger.toFixed(4) !== order.triggerPrice) {
          await db
            .update(pendingOrders)
            .set({ triggerPrice: newTrigger.toFixed(4), updatedAt: new Date() })
            .where(eq(pendingOrders.id, order.id));
          order.triggerPrice = newTrigger.toFixed(4);
        }
      }
    }

    const fired = decideFiredOrder(triggered, bars, recentLow);
    if (!fired) continue;

    logger.warn(
      {
        symbol: coin.symbol,
        kind: fired.kind,
        marketPrice: fired.marketPrice,
        recentLow,
        barsScanned: bars.length,
      },
      "Stop loss fired",
    );

    await executeExit({
      strategyId: position.strategyId,
      symbol: coin.symbol,
      decisionId: null,
      marketPrice: fired.marketPrice,
      takerFeeRate: Number(coin.takerFeeRate),
      forced: fired.forced,
      reason: `auto SL: ${fired.kind}`,
    });

    await db.insert(systemEvents).values({
      strategyId: position.strategyId,
      kind: "price_monitor_triggered",
      severity: "warning",
      message: `${coin.symbol} SL fired: ${fired.kind}`,
      payload: {
        marketPrice: fired.marketPrice,
        recentLow,
        recentHigh,
        slippageApplied: fired.forced,
        barsScanned: bars.length,
      },
    });

    await notify({
      level: "warning",
      title: `⚠️ 逆指値発火: ${coin.symbol}`,
      body: `種別: \`${fired.kind}\`${fired.forced ? " (成行強制、スリッページ 0.3%)" : " (指値、スリッページなし)"}`,
      fields: {
        発火価格: `¥${Math.round(fired.marketPrice).toLocaleString()}`,
        直近安値: `¥${Math.round(recentLow).toLocaleString()}`,
        ピーク: `¥${Math.round(peak).toLocaleString()}`,
      },
    });
  }
}
