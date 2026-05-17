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

interface Bar {
  low: number;
  high: number;
  close: number;
}

function toBar(raw: { low: string; high: string; close: string }): Bar {
  return { low: Number(raw.low), high: Number(raw.high), close: Number(raw.close) };
}

interface FiredSignal {
  kind: string;
  marketPrice: number;
  forced: boolean;
}

/**
 * Stop-Limit を優先、約定可能性なければ Stop-Market 系で判定。
 * 戻り値: 約定する order の executeExit 引数情報 (なければ null)。
 */
function decideFiredOrder(
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

function todayYyyymmdd(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 全 open ポジションの 1 分足を取得 → ピーク更新 + 逆指値タッチ判定。
 *
 * 約定判定 (1m bar):
 *   - stop_limit_primary: bar.low <= trigger AND bar.high >= limit
 *     → limit_price で約定、スリッページなし
 *   - stop_market_entry / stop_market_peak: bar.low <= trigger
 *     → trigger × (1 - 0.003) で約定、スリッページ 0.3% 控除
 *
 * 同一バー内で複数発火可能なら Stop-Limit を優先 (約定価格が良い)。
 * 1 ポジション 1 約定で他はキャンセル(executeExit が pending_orders を inactive 化)。
 */
export async function runPriceMonitor(): Promise<void> {
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
    let bars: Bar[] = [];
    try {
      const klines = await getKlines(symbolJpy, "1min", todayYyyymmdd());
      bars = klines.slice(-5).map(toBar);
    } catch (err) {
      logger.warn({ err, symbol: coin.symbol }, "Failed to fetch 1m kline");
      continue;
    }
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
      { symbol: coin.symbol, kind: fired.kind, marketPrice: fired.marketPrice, recentLow },
      "Stop loss fired",
    );

    await executeExit({
      model: position.model,
      symbol: coin.symbol,
      decisionId: null,
      marketPrice: fired.marketPrice,
      takerFeeRate: Number(coin.takerFeeRate),
      forced: fired.forced,
      reason: `auto SL: ${fired.kind}`,
    });

    await db.insert(systemEvents).values({
      model: position.model,
      kind: "price_monitor_triggered",
      severity: "warning",
      message: `${coin.symbol} SL fired: ${fired.kind}`,
      payload: {
        marketPrice: fired.marketPrice,
        recentLow,
        recentHigh,
        slippageApplied: fired.forced,
      },
    });

    await notify({
      level: "warning",
      title: `⚠️ Stop Loss Fired: ${coin.symbol}`,
      body: `Kind: \`${fired.kind}\`${fired.forced ? " (forced market, 0.3% slippage)" : " (limit, no slippage)"}`,
      fields: {
        model: position.model,
        marketPrice: `¥${Math.round(fired.marketPrice).toLocaleString()}`,
        recentLow: `¥${Math.round(recentLow).toLocaleString()}`,
        peak: `¥${Math.round(peak).toLocaleString()}`,
      },
    });
  }
}
