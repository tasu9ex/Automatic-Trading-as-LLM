import { db } from "@/db/client";
import { coins, orders, pendingOrders, portfolios, positions, trades } from "@/db/schema";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { and, eq } from "drizzle-orm";
import { calculateFill } from "./fees";

const logger = createLogger("executor");

/**
 * 2 段階 SL 設計 (アグレ設定):
 *   [1] stop_limit_primary  通常損切り、約定品質重視
 *       trigger = 建値 × 0.75 (-25%)
 *       limit   = 建値 × 0.73 (-27%)
 *   [2] stop_market_entry   最終防衛 (深い)、必ず約定
 *       trigger = 建値 × 0.65 (-35%)、スリッページ 0.3%
 *   [3] stop_market_peak    trailing、ピーク追従
 *       trigger = peak × 0.5 (-50%)、スリッページ 0.3%
 */
const STOP_LIMIT_TRIGGER_RATIO = 0.75; // -25%
const STOP_LIMIT_LIMIT_RATIO = 0.73; // -27%
const STOP_MARKET_ENTRY_RATIO = 0.65; // -35%
const STOP_MARKET_PEAK_RATIO = 0.5; // -50%

export interface ExecuteEntryInput {
  model: string;
  symbol: string;
  decisionId: string | null;
  marketPrice: number;
  budgetJpy: number;
  takerFeeRate: number;
  entryReason: string | null;
  /** Entry 時の仮説 (Exit で reference として参照、ピラミ時は最新で上書き) */
  expectedHoldingDays?: { min: number; max: number } | null;
  targetPriceJpy?: number | null;
  exitCondition?: string | null;
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
      // ピラミッディング: 加重平均で建値更新、Entry 仮説も最新で上書き
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
          entryReason: input.entryReason,
          entryExpectedHoldingDaysMin: input.expectedHoldingDays?.min ?? null,
          entryExpectedHoldingDaysMax: input.expectedHoldingDays?.max ?? null,
          entryTargetPriceJpy: input.targetPriceJpy?.toFixed(4) ?? null,
          entryExitCondition: input.exitCondition ?? null,
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
          entryExpectedHoldingDaysMin: input.expectedHoldingDays?.min ?? null,
          entryExpectedHoldingDaysMax: input.expectedHoldingDays?.max ?? null,
          entryTargetPriceJpy: input.targetPriceJpy?.toFixed(4) ?? null,
          entryExitCondition: input.exitCondition ?? null,
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

    // ピラミッディング時は既存の SL を全部無効化してから再配置(建値が変わるため)
    if (existing) {
      await tx
        .update(pendingOrders)
        .set({ active: false, updatedAt: new Date() })
        .where(and(eq(pendingOrders.positionId, positionId), eq(pendingOrders.active, true)));
    }

    const currentPeak = Math.max(Number(existing?.peakPrice ?? 0), fill.executedPrice);

    // [1] Stop-Limit primary (-25% trigger, -27% limit)
    await tx.insert(pendingOrders).values({
      positionId,
      coinId: coin.id,
      model: input.model,
      kind: "stop_limit_primary",
      triggerPrice: (newAvgPrice * STOP_LIMIT_TRIGGER_RATIO).toFixed(4),
      limitPrice: (newAvgPrice * STOP_LIMIT_LIMIT_RATIO).toFixed(4),
      createdBy: "code",
    });

    // [2] Stop-Market entry (-35% market, 最終防衛)
    await tx.insert(pendingOrders).values({
      positionId,
      coinId: coin.id,
      model: input.model,
      kind: "stop_market_entry",
      triggerPrice: (newAvgPrice * STOP_MARKET_ENTRY_RATIO).toFixed(4),
      createdBy: "code",
    });

    // [3] Stop-Market peak (-50% trailing、peak は price-monitor が動的更新)
    await tx.insert(pendingOrders).values({
      positionId,
      coinId: coin.id,
      model: input.model,
      kind: "stop_market_peak",
      triggerPrice: (currentPeak * STOP_MARKET_PEAK_RATIO).toFixed(4),
      createdBy: "code",
    });

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
      title: `🟢 買い ${input.symbol}`,
      fields: {
        モデル: input.model,
        投入額: `¥${input.budgetJpy.toLocaleString()}`,
        数量: fill.quantity.toFixed(8),
        価格: `¥${Math.round(fill.executedPrice).toLocaleString()}`,
        手数料: `¥${fill.feeJpy.toFixed(0)}`,
        残現金: `¥${Math.round(newCash).toLocaleString()}`,
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
  /**
   * 決済比率 (0.1-1.0)。1.0 = 全決済 (デフォルト、従来通り)、<1.0 = 部分決済。
   * 部分決済時は position を open のまま残し quantity を削減する。
   * pending_orders は price 駆動で qty 非依存なので維持 (price-monitor 側で現 qty 計算)。
   */
  quantityRatio?: number;
}

/**
 * Close 仮想約定:
 *   1. open position 取得
 *   2. orders 登録 (sell qty = position.qty * ratio)
 *   3. trades 登録 (pnl 計算)
 *   4. ratio === 1.0: positions を closed に + pending_orders を inactive
 *      ratio  <  1.0: positions.quantity を削減 (open 維持)、pending_orders は維持
 *   5. portfolios.cash_jpy 加算 + realized_pnl_jpy 更新
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

    const positionQty = Number(position.quantity);
    const rawRatio = input.quantityRatio ?? 1.0;
    const ratio = Math.min(1.0, Math.max(0, rawRatio));
    const sellQty = positionQty * ratio;
    const isFullClose = ratio >= 0.999999; // 浮動小数誤差吸収

    const fill = calculateFill({
      side: "sell",
      marketPrice: input.marketPrice,
      quoteAmountJpy: sellQty * input.marketPrice,
      takerFeeRate: input.takerFeeRate,
      slippageRate: input.forced ? 0.003 : 0,
    });

    const pnlJpy = (fill.executedPrice - Number(position.avgEntryPrice)) * sellQty - fill.feeJpy;

    const [order] = await tx
      .insert(orders)
      .values({
        decisionId: input.decisionId,
        coinId: coin.id,
        model: input.model,
        side: "sell",
        status: "filled",
        sizeJpy: (sellQty * fill.executedPrice).toFixed(4),
        quantity: sellQty.toFixed(10),
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
      quantity: sellQty.toFixed(10),
      price: fill.executedPrice.toFixed(4),
      fee: fill.feeJpy.toFixed(4),
      pnlJpy: pnlJpy.toFixed(4),
      executedAt: new Date(),
    });

    if (isFullClose) {
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
    } else {
      // 部分決済: position の qty を削減し open のまま維持。
      // 平均建値は変更しない (残量の建値は変わらない)。
      // pending_orders は qty 非依存 (price 駆動) なので維持。
      const remainingQty = positionQty - sellQty;
      await tx
        .update(positions)
        .set({
          quantity: remainingQty.toFixed(10),
          realizedPnlJpy: (Number(position.realizedPnlJpy) + pnlJpy).toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(positions.id, position.id));
    }

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
        ratio,
        newCash,
      },
      isFullClose ? "executeExit done (full)" : "executeExit done (partial)",
    );

    const isProfit = pnlJpy >= 0;
    const partialLabel = isFullClose ? "" : ` (${Math.round(ratio * 100)}%)`;
    await notify({
      level: input.forced ? "warning" : isProfit ? "success" : "info",
      title: `${isProfit ? "🔵" : "🔴"} 売り${partialLabel} ${input.symbol}${input.forced ? " (強制)" : ""}`,
      body: input.reason ?? undefined,
      fields: {
        モデル: input.model,
        数量: sellQty.toFixed(8),
        価格: `¥${Math.round(fill.executedPrice).toLocaleString()}`,
        損益: `${isProfit ? "+" : ""}¥${Math.round(pnlJpy).toLocaleString()}`,
        手数料: `¥${fill.feeJpy.toFixed(0)}`,
        スリッページ: input.forced ? `¥${fill.slippageJpy.toFixed(0)}` : "0",
        残現金: `¥${Math.round(newCash).toLocaleString()}`,
      },
    });
  });
}
