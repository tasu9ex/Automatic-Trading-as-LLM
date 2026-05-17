import { db } from "@/db/client";
import { coins, orders, pendingOrders, portfolios, positions, trades } from "@/db/schema";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { and, eq } from "drizzle-orm";
import { calculateFill } from "./fees";

const logger = createLogger("executor");

/** 個別緊急 SL の閾値 (アグレ設定) */
const STOP_LOSS_ENTRY_RATIO = 0.65; // 建値比 -35%
const STOP_LOSS_PEAK_RATIO = 0.5; // ピーク比 -50% (peak_price 監視は別経路)

export interface ExecuteEntryInput {
  model: string;
  symbol: string;
  decisionId: string | null;
  marketPrice: number;
  budgetJpy: number;
  takerFeeRate: number;
  entryReason: string | null;
}

/**
 * Buy 仮想約定:
 *   1. orders 登録
 *   2. positions に追加 (新規 or ピラミッディング)
 *   3. trades 登録
 *   4. pending_orders に逆指値 (建値比) を自動配置
 *   5. portfolios.cash_jpy から控除
 */
export async function executeEntry(input: ExecuteEntryInput): Promise<void> {
  const fill = calculateFill({
    side: "buy",
    marketPrice: input.marketPrice,
    quoteAmountJpy: input.budgetJpy,
    takerFeeRate: input.takerFeeRate,
  });

  await db.transaction(async (tx) => {
    const coin = (await tx.select().from(coins).where(eq(coins.symbol, input.symbol)).limit(1))[0];
    if (!coin) throw new Error(`Coin not found: ${input.symbol}`);

    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.model, input.model)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${input.model}`);

    const [order] = await tx
      .insert(orders)
      .values({
        decisionId: input.decisionId,
        coinId: coin.id,
        model: input.model,
        side: "buy",
        status: "filled",
        sizeJpy: input.budgetJpy.toFixed(4),
        quantity: fill.quantity.toFixed(10),
        price: fill.executedPrice.toFixed(4),
        fee: fill.feeJpy.toFixed(4),
        slippage: fill.slippageJpy.toFixed(4),
      })
      .returning();
    if (!order) throw new Error("order insert failed");

    const existing = (
      await tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.model, input.model),
            eq(positions.coinId, coin.id),
            eq(positions.status, "open"),
          ),
        )
        .limit(1)
    )[0];

    let positionId: string;
    let newAvgPrice: number;
    if (existing) {
      // ピラミッディング: 加重平均で建値更新
      const prevQty = Number(existing.quantity);
      const prevAvg = Number(existing.avgEntryPrice);
      const newQty = prevQty + fill.quantity;
      newAvgPrice = (prevAvg * prevQty + fill.executedPrice * fill.quantity) / newQty;

      await tx
        .update(positions)
        .set({
          quantity: newQty.toFixed(10),
          avgEntryPrice: newAvgPrice.toFixed(4),
          peakPrice: Math.max(Number(existing.peakPrice), fill.executedPrice).toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(positions.id, existing.id));
      positionId = existing.id;
    } else {
      newAvgPrice = fill.executedPrice;
      const [pos] = await tx
        .insert(positions)
        .values({
          model: input.model,
          coinId: coin.id,
          status: "open",
          quantity: fill.quantity.toFixed(10),
          avgEntryPrice: fill.executedPrice.toFixed(4),
          peakPrice: fill.executedPrice.toFixed(4),
          troughPrice: fill.executedPrice.toFixed(4),
          entryReason: input.entryReason,
          openedAt: new Date(),
        })
        .returning();
      if (!pos) throw new Error("position insert failed");
      positionId = pos.id;
    }

    await tx.insert(trades).values({
      positionId,
      orderId: order.id,
      coinId: coin.id,
      model: input.model,
      side: "buy",
      quantity: fill.quantity.toFixed(10),
      price: fill.executedPrice.toFixed(4),
      fee: fill.feeJpy.toFixed(4),
      executedAt: new Date(),
    });

    // 建値ベース逆指値を新規/更新で配置 (-35%)
    const triggerEntry = newAvgPrice * STOP_LOSS_ENTRY_RATIO;
    await tx
      .insert(pendingOrders)
      .values({
        positionId,
        coinId: coin.id,
        model: input.model,
        kind: "stop_loss_entry_based",
        triggerPrice: triggerEntry.toFixed(4),
        createdBy: "code",
      })
      .onConflictDoNothing();

    // ピーク比逆指値 (-50%) も同様 (peak は別途 price-monitor で更新される)
    const triggerPeak = Number(existing?.peakPrice ?? fill.executedPrice) * STOP_LOSS_PEAK_RATIO;
    await tx
      .insert(pendingOrders)
      .values({
        positionId,
        coinId: coin.id,
        model: input.model,
        kind: "stop_loss_peak_based",
        triggerPrice: triggerPeak.toFixed(4),
        createdBy: "code",
      })
      .onConflictDoNothing();

    // 現金控除
    const newCash = Number(portfolio.cashJpy) - fill.netCashJpy;
    await tx
      .update(portfolios)
      .set({ cashJpy: newCash.toFixed(4), updatedAt: new Date() })
      .where(eq(portfolios.id, portfolio.id));

    logger.info(
      {
        model: input.model,
        symbol: input.symbol,
        budgetJpy: input.budgetJpy,
        quantity: fill.quantity,
        executedPrice: fill.executedPrice,
        feeJpy: fill.feeJpy,
        newAvgPrice,
        newCash,
      },
      "executeEntry done",
    );

    await notify({
      level: "success",
      title: `🟢 BUY ${input.symbol}`,
      fields: {
        model: input.model,
        budget: `¥${input.budgetJpy.toLocaleString()}`,
        qty: fill.quantity.toFixed(8),
        price: `¥${Math.round(fill.executedPrice).toLocaleString()}`,
        fee: `¥${fill.feeJpy.toFixed(0)}`,
        cash: `¥${Math.round(newCash).toLocaleString()}`,
      },
    });
  });
}

export interface ExecuteExitInput {
  model: string;
  symbol: string;
  decisionId: string | null;
  marketPrice: number;
  takerFeeRate: number;
  /** 逆指値タッチによる強制決済か (true ならスリッページ 0.3% 適用) */
  forced?: boolean;
  reason?: string;
}

/**
 * Close 仮想約定 (all-or-nothing):
 *   1. open position 取得
 *   2. orders 登録
 *   3. trades 登録 (pnl 計算)
 *   4. positions を closed に
 *   5. 該当 pending_orders を inactive に
 *   6. portfolios.cash_jpy 加算 + realized_pnl_jpy 更新
 */
export async function executeExit(input: ExecuteExitInput): Promise<void> {
  await db.transaction(async (tx) => {
    const coin = (await tx.select().from(coins).where(eq(coins.symbol, input.symbol)).limit(1))[0];
    if (!coin) throw new Error(`Coin not found: ${input.symbol}`);

    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.model, input.model)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${input.model}`);

    const position = (
      await tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.model, input.model),
            eq(positions.coinId, coin.id),
            eq(positions.status, "open"),
          ),
        )
        .limit(1)
    )[0];
    if (!position) {
      logger.warn({ model: input.model, symbol: input.symbol }, "executeExit: no open position");
      return;
    }

    const qty = Number(position.quantity);
    const fill = calculateFill({
      side: "sell",
      marketPrice: input.marketPrice,
      quoteAmountJpy: qty * input.marketPrice,
      takerFeeRate: input.takerFeeRate,
      slippageRate: input.forced ? 0.003 : 0,
    });

    const pnlJpy = (fill.executedPrice - Number(position.avgEntryPrice)) * qty - fill.feeJpy;

    const [order] = await tx
      .insert(orders)
      .values({
        decisionId: input.decisionId,
        coinId: coin.id,
        model: input.model,
        side: "sell",
        status: "filled",
        sizeJpy: (qty * fill.executedPrice).toFixed(4),
        quantity: qty.toFixed(10),
        price: fill.executedPrice.toFixed(4),
        fee: fill.feeJpy.toFixed(4),
        slippage: fill.slippageJpy.toFixed(4),
        reason: input.reason,
      })
      .returning();
    if (!order) throw new Error("order insert failed");

    await tx.insert(trades).values({
      positionId: position.id,
      orderId: order.id,
      coinId: coin.id,
      model: input.model,
      side: "sell",
      quantity: qty.toFixed(10),
      price: fill.executedPrice.toFixed(4),
      fee: fill.feeJpy.toFixed(4),
      pnlJpy: pnlJpy.toFixed(4),
      executedAt: new Date(),
    });

    await tx
      .update(positions)
      .set({
        status: "closed",
        closedAt: new Date(),
        realizedPnlJpy: (Number(position.realizedPnlJpy) + pnlJpy).toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, position.id));

    await tx
      .update(pendingOrders)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(pendingOrders.positionId, position.id), eq(pendingOrders.active, true)));

    const newCash = Number(portfolio.cashJpy) + fill.netCashJpy;
    await tx
      .update(portfolios)
      .set({ cashJpy: newCash.toFixed(4), updatedAt: new Date() })
      .where(eq(portfolios.id, portfolio.id));

    logger.info(
      {
        model: input.model,
        symbol: input.symbol,
        executedPrice: fill.executedPrice,
        pnlJpy,
        forced: input.forced,
        reason: input.reason,
        newCash,
      },
      "executeExit done",
    );

    const isProfit = pnlJpy >= 0;
    await notify({
      level: input.forced ? "warning" : isProfit ? "success" : "info",
      title: `${isProfit ? "🔵" : "🔴"} SELL ${input.symbol}${input.forced ? " (FORCED)" : ""}`,
      body: input.reason ?? undefined,
      fields: {
        model: input.model,
        qty: qty.toFixed(8),
        price: `¥${Math.round(fill.executedPrice).toLocaleString()}`,
        pnl: `${isProfit ? "+" : ""}¥${Math.round(pnlJpy).toLocaleString()}`,
        fee: `¥${fill.feeJpy.toFixed(0)}`,
        slippage: input.forced ? `¥${fill.slippageJpy.toFixed(0)}` : "0",
        cash: `¥${Math.round(newCash).toLocaleString()}`,
      },
    });
  });
}
