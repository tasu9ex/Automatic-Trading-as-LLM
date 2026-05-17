import { db } from "@/db/client";
import { coins, pendingOrders, positions, systemEvents } from "@/db/schema";
import { getKlines } from "@/lib/clients/gmo";
import { executeExit } from "@/lib/executor";
import { createLogger } from "@/lib/logging";
import { and, eq } from "drizzle-orm";

const logger = createLogger("price-monitor");

interface Bar {
  low: number;
  high: number;
}

function toBar(raw: { low: string; high: string }): Bar {
  return { low: Number(raw.low), high: Number(raw.high) };
}

function todayYyyymmdd(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 全 open ポジションの 1 分足を取得 → ピーク更新 + 逆指値タッチ判定。
 * タッチ → executeExit({ forced: true }) で仮想決済 + 通知。
 */
export async function runPriceMonitor(): Promise<void> {
  const openPositions = await db
    .select({
      position: positions,
      coin: coins,
    })
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

    const peak = Math.max(Number(position.peakPrice), recentHigh);
    const trough = Math.min(Number(position.troughPrice), recentLow);
    if (peak !== Number(position.peakPrice) || trough !== Number(position.troughPrice)) {
      await db
        .update(positions)
        .set({
          peakPrice: peak.toFixed(4),
          troughPrice: trough.toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(positions.id, position.id));
    }

    const triggered = await db
      .select()
      .from(pendingOrders)
      .where(and(eq(pendingOrders.positionId, position.id), eq(pendingOrders.active, true)));

    for (const order of triggered) {
      const trigger = Number(order.triggerPrice);
      let liveTrigger = trigger;
      if (order.kind === "stop_loss_peak_based") {
        // ピークに連動して引き直す: 現在ピーク × ratio (= 0.5)
        liveTrigger = peak * 0.5;
        if (liveTrigger.toFixed(4) !== order.triggerPrice) {
          await db
            .update(pendingOrders)
            .set({ triggerPrice: liveTrigger.toFixed(4), updatedAt: new Date() })
            .where(eq(pendingOrders.id, order.id));
        }
      }

      if (recentLow <= liveTrigger) {
        logger.warn(
          {
            symbol: coin.symbol,
            kind: order.kind,
            trigger: liveTrigger,
            recentLow,
          },
          "Stop loss triggered",
        );

        await executeExit({
          model: position.model,
          symbol: coin.symbol,
          decisionId: null,
          marketPrice: liveTrigger,
          takerFeeRate: Number(coin.takerFeeRate),
          forced: true,
          reason: `auto stop loss (${order.kind})`,
        });

        await db.insert(systemEvents).values({
          model: position.model,
          kind: "price_monitor_triggered",
          severity: "warning",
          message: `${coin.symbol} stop loss (${order.kind})`,
          payload: { triggerPrice: liveTrigger, recentLow, recentHigh },
        });

        break; // このポジションは決済済み
      }
    }
  }
}
