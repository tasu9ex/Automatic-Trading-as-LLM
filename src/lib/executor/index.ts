/**
 * 注文ライフサイクル実装。
 *
 * 設計:
 *   placeOrder()    → DB に status=placed で記録 + "📤 発注" 通知
 *   fillOrder()     → status=filled に更新 + position/trade/portfolio 更新 + "🟢 約定" 通知
 *   expireOrder()   → status=expired (実マネー時、TTL 超過で取引所がキャンセル)
 *   rejectOrder()   → status=rejected (取引所が拒否)
 *
 * Mode:
 *   PAPER (env PAPER_TRADE=true、default): executeEntry/Exit が placeOrder → fillOrder を
 *     即時 sequential 実行 (シミュ約定価格を calculateFill で算出)
 *   REAL (PAPER_TRADE=false): executeEntry/Exit が placeOrder のみ → GMO API に発注
 *     fillOrder / expireOrder / rejectOrder は WebSocket / poll worker から呼ぶ (今は stub)
 *
 * 2 段階 SL 設計 (アグレ設定):
 *   [1] stop_limit_primary  通常損切り、約定品質重視
 *       trigger = 建値 × 0.75 (-25%), limit = 建値 × 0.73 (-27%)
 *   [2] stop_market_entry   最終防衛 (深い)、必ず約定
 *       trigger = 建値 × 0.65 (-35%)、スリッページ 0.3%
 *   [3] stop_market_peak    trailing、ピーク追従
 *       trigger = peak × 0.5 (-50%)、スリッページ 0.3%
 */

import { db } from "@/db/client";
import { coins, orders, pendingOrders, portfolios, positions, trades } from "@/db/schema";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { and, eq } from "drizzle-orm";
import { type FillResult, calculateFill } from "./fees";

const logger = createLogger("executor");

const STOP_LIMIT_TRIGGER_RATIO = 0.75; // -25%
const STOP_LIMIT_LIMIT_RATIO = 0.73; // -27%
const STOP_MARKET_ENTRY_RATIO = 0.65; // -35%
const STOP_MARKET_PEAK_RATIO = 0.5; // -50%

function isPaperMode(): boolean {
  return (process.env.PAPER_TRADE ?? "true").toLowerCase() !== "false";
}

function expiresAtFrom(now: Date, ttlHours: number | null | undefined): Date | null {
  if (!ttlHours || ttlHours <= 0) return null;
  return new Date(now.getTime() + ttlHours * 3_600_000);
}

// =====================================================================
// Entry (Buy) ライフサイクル
// =====================================================================

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
  /** 注文 TTL (時間)。null = 無期限。実マネー時のみ意味あり、ペーパーは記録のみ */
  ttlHours?: number | null;
}

/**
 * Entry 注文を place + (ペーパーは即 fill)。
 * 実マネー mode では fill は GMO webhook 経由で fillEntryOrder() が後から呼ばれる。
 */
export async function executeEntry(input: ExecuteEntryInput): Promise<void> {
  const { orderId } = await placeEntryOrder(input);
  if (isPaperMode()) {
    const fill = calculateFill({
      side: "buy",
      marketPrice: input.marketPrice,
      quoteAmountJpy: input.budgetJpy,
      takerFeeRate: input.takerFeeRate,
    });
    await fillEntryOrder({
      orderId,
      model: input.model,
      symbol: input.symbol,
      fill,
      entryReason: input.entryReason,
      expectedHoldingDays: input.expectedHoldingDays ?? null,
      targetPriceJpy: input.targetPriceJpy ?? null,
      exitCondition: input.exitCondition ?? null,
    });
  }
  // REAL mode: place のみ。fill は webhook handler から fillEntryOrder() 呼出
}

/** Entry 発注: status=placed で orders 行を作成し "📤 発注" 通知。実マネー時はここで GMO API を呼ぶ */
async function placeEntryOrder(input: ExecuteEntryInput): Promise<{ orderId: string }> {
  if (!isPaperMode()) {
    throw new Error(
      "REAL mode placeEntryOrder not implemented (GMO Private API integration pending)",
    );
  }
  const coin = (await db.select().from(coins).where(eq(coins.symbol, input.symbol)).limit(1))[0];
  if (!coin) throw new Error(`Coin not found: ${input.symbol}`);

  const intendedQty = input.budgetJpy / Math.max(input.marketPrice, 1);
  const now = new Date();
  const expires = expiresAtFrom(now, input.ttlHours);

  const [order] = await db
    .insert(orders)
    .values({
      decisionId: input.decisionId,
      coinId: coin.id,
      model: input.model,
      side: "buy",
      status: "placed",
      sizeJpy: input.budgetJpy.toFixed(4),
      quantity: intendedQty.toFixed(10),
      price: input.marketPrice.toFixed(4),
      fee: "0",
      slippage: "0",
      reason: input.entryReason,
      ttlHours: input.ttlHours?.toFixed(2) ?? null,
      expiresAt: expires,
    })
    .returning();
  if (!order) throw new Error("order insert failed");

  await notify({
    level: "info",
    title: `📤 発注 ${input.symbol} (buy)`,
    fields: {
      投入額: `¥${input.budgetJpy.toLocaleString()}`,
      参考価格: `¥${Math.round(input.marketPrice).toLocaleString()}`,
      TTL: input.ttlHours ? `${input.ttlHours}h` : "無期限",
    },
  });

  return { orderId: order.id };
}

interface FillEntryArgs {
  orderId: string;
  model: string;
  symbol: string;
  fill: FillResult;
  entryReason: string | null;
  expectedHoldingDays: { min: number; max: number } | null;
  targetPriceJpy: number | null;
  exitCondition: string | null;
}

/** Entry 約定: orders を filled に更新 + position/trade/portfolio 反映 + "🟢 約定" 通知 */
export async function fillEntryOrder(args: FillEntryArgs): Promise<void> {
  const { orderId, model, symbol, fill } = args;
  await db.transaction(async (tx) => {
    const coin = (await tx.select().from(coins).where(eq(coins.symbol, symbol)).limit(1))[0];
    if (!coin) throw new Error(`Coin not found: ${symbol}`);

    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.model, model)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${model}`);

    await tx
      .update(orders)
      .set({
        status: "filled",
        sizeJpy: (fill.quantity * fill.executedPrice).toFixed(4),
        quantity: fill.quantity.toFixed(10),
        price: fill.executedPrice.toFixed(4),
        fee: fill.feeJpy.toFixed(4),
        slippage: fill.slippageJpy.toFixed(4),
        completedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    const existing = (
      await tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.model, model),
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
          entryReason: args.entryReason,
          entryExpectedHoldingDaysMin: args.expectedHoldingDays?.min ?? null,
          entryExpectedHoldingDaysMax: args.expectedHoldingDays?.max ?? null,
          entryTargetPriceJpy: args.targetPriceJpy?.toFixed(4) ?? null,
          entryExitCondition: args.exitCondition,
          updatedAt: new Date(),
        })
        .where(eq(positions.id, existing.id));
      positionId = existing.id;
    } else {
      newAvgPrice = fill.executedPrice;
      const [pos] = await tx
        .insert(positions)
        .values({
          model,
          coinId: coin.id,
          status: "open",
          quantity: fill.quantity.toFixed(10),
          avgEntryPrice: fill.executedPrice.toFixed(4),
          peakPrice: fill.executedPrice.toFixed(4),
          troughPrice: fill.executedPrice.toFixed(4),
          entryReason: args.entryReason,
          entryExpectedHoldingDaysMin: args.expectedHoldingDays?.min ?? null,
          entryExpectedHoldingDaysMax: args.expectedHoldingDays?.max ?? null,
          entryTargetPriceJpy: args.targetPriceJpy?.toFixed(4) ?? null,
          entryExitCondition: args.exitCondition,
          openedAt: new Date(),
        })
        .returning();
      if (!pos) throw new Error("position insert failed");
      positionId = pos.id;
    }

    await tx.insert(trades).values({
      positionId,
      orderId,
      coinId: coin.id,
      model,
      side: "buy",
      quantity: fill.quantity.toFixed(10),
      price: fill.executedPrice.toFixed(4),
      fee: fill.feeJpy.toFixed(4),
      executedAt: new Date(),
    });

    // ピラミッディング時は既存の SL を全部無効化してから再配置 (建値が変わるため)
    if (existing) {
      await tx
        .update(pendingOrders)
        .set({ active: false, updatedAt: new Date() })
        .where(and(eq(pendingOrders.positionId, positionId), eq(pendingOrders.active, true)));
    }

    const currentPeak = Math.max(Number(existing?.peakPrice ?? 0), fill.executedPrice);

    await tx.insert(pendingOrders).values({
      positionId,
      coinId: coin.id,
      model,
      kind: "stop_limit_primary",
      triggerPrice: (newAvgPrice * STOP_LIMIT_TRIGGER_RATIO).toFixed(4),
      limitPrice: (newAvgPrice * STOP_LIMIT_LIMIT_RATIO).toFixed(4),
      createdBy: "code",
    });
    await tx.insert(pendingOrders).values({
      positionId,
      coinId: coin.id,
      model,
      kind: "stop_market_entry",
      triggerPrice: (newAvgPrice * STOP_MARKET_ENTRY_RATIO).toFixed(4),
      createdBy: "code",
    });
    await tx.insert(pendingOrders).values({
      positionId,
      coinId: coin.id,
      model,
      kind: "stop_market_peak",
      triggerPrice: (currentPeak * STOP_MARKET_PEAK_RATIO).toFixed(4),
      createdBy: "code",
    });

    const newCash = Number(portfolio.cashJpy) - fill.netCashJpy;
    await tx
      .update(portfolios)
      .set({ cashJpy: newCash.toFixed(4), updatedAt: new Date() })
      .where(eq(portfolios.id, portfolio.id));

    logger.info(
      {
        model,
        symbol,
        quantity: fill.quantity,
        executedPrice: fill.executedPrice,
        feeJpy: fill.feeJpy,
        newAvgPrice,
        newCash,
      },
      "fillEntryOrder done",
    );

    await notify({
      level: "success",
      title: `🟢 約定 (買) ${symbol}`,
      fields: {
        数量: fill.quantity.toFixed(8),
        価格: `¥${Math.round(fill.executedPrice).toLocaleString()}`,
        手数料: `¥${fill.feeJpy.toFixed(0)}`,
        残現金: `¥${Math.round(newCash).toLocaleString()}`,
      },
    });
  });
}

// =====================================================================
// Exit (Sell) ライフサイクル
// =====================================================================

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
   * 決済比率 (0.1-1.0)。1.0 = 全決済 (デフォルト)、<1.0 = 部分決済。
   * 部分決済時は position を open のまま残し quantity を削減する。
   */
  quantityRatio?: number;
  /** 注文 TTL (時間)。null = 無期限。実マネー時のみ意味あり */
  ttlHours?: number | null;
}

/**
 * Exit 注文を place + (ペーパーは即 fill)。
 * 実マネー mode では fill は GMO webhook 経由で fillExitOrder() が後から呼ばれる。
 */
export async function executeExit(input: ExecuteExitInput): Promise<void> {
  const placed = await placeExitOrder(input);
  if (!placed) return; // 保有なし (silent)
  if (isPaperMode()) {
    const rawRatio = input.quantityRatio ?? 1.0;
    const ratio = Math.min(1.0, Math.max(0, rawRatio));
    const sellQty = placed.positionQty * ratio;
    const fill = calculateFill({
      side: "sell",
      marketPrice: input.marketPrice,
      quoteAmountJpy: sellQty * input.marketPrice,
      takerFeeRate: input.takerFeeRate,
      slippageRate: input.forced ? 0.003 : 0,
    });
    await fillExitOrder({
      orderId: placed.orderId,
      positionId: placed.positionId,
      model: input.model,
      symbol: input.symbol,
      fill,
      sellQty,
      ratio,
      forced: input.forced,
      reason: input.reason,
    });
  }
  // REAL mode: place のみ。fill は webhook handler から fillExitOrder() 呼出
}

interface PlacedExitOrder {
  orderId: string;
  positionId: string;
  positionQty: number;
  positionAvg: number;
}

/** Exit 発注: status=placed で orders 行を作成し "📤 発注" 通知 */
async function placeExitOrder(input: ExecuteExitInput): Promise<PlacedExitOrder | null> {
  if (!isPaperMode()) {
    throw new Error(
      "REAL mode placeExitOrder not implemented (GMO Private API integration pending)",
    );
  }
  const coin = (await db.select().from(coins).where(eq(coins.symbol, input.symbol)).limit(1))[0];
  if (!coin) throw new Error(`Coin not found: ${input.symbol}`);

  const position = (
    await db
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
    logger.warn({ model: input.model, symbol: input.symbol }, "placeExitOrder: no open position");
    return null;
  }

  const positionQty = Number(position.quantity);
  const rawRatio = input.quantityRatio ?? 1.0;
  const ratio = Math.min(1.0, Math.max(0, rawRatio));
  const sellQty = positionQty * ratio;
  const now = new Date();
  const expires = expiresAtFrom(now, input.ttlHours);

  const [order] = await db
    .insert(orders)
    .values({
      decisionId: input.decisionId,
      coinId: coin.id,
      model: input.model,
      side: "sell",
      status: "placed",
      sizeJpy: (sellQty * input.marketPrice).toFixed(4),
      quantity: sellQty.toFixed(10),
      price: input.marketPrice.toFixed(4),
      fee: "0",
      slippage: "0",
      reason: input.reason ?? null,
      ttlHours: input.ttlHours?.toFixed(2) ?? null,
      expiresAt: expires,
    })
    .returning();
  if (!order) throw new Error("order insert failed");

  const isFull = ratio >= 0.999999;
  // forced=true (price-monitor SL / kill-switch) のときは「逆指値発火」「Kill Switch」
  // の上位通知と重複するので発注通知をスキップ。約定通知は出す
  if (!input.forced) {
    await notify({
      level: "info",
      title: `📤 発注 ${input.symbol} (sell${isFull ? "" : ` ${Math.round(ratio * 100)}%`})`,
      body: input.reason ?? undefined,
      fields: {
        数量: sellQty.toFixed(8),
        参考価格: `¥${Math.round(input.marketPrice).toLocaleString()}`,
        TTL: input.ttlHours ? `${input.ttlHours}h` : "無期限",
      },
    });
  }

  return {
    orderId: order.id,
    positionId: position.id,
    positionQty,
    positionAvg: Number(position.avgEntryPrice),
  };
}

interface FillExitArgs {
  orderId: string;
  positionId: string;
  model: string;
  symbol: string;
  fill: FillResult;
  sellQty: number;
  ratio: number;
  forced?: boolean;
  reason?: string;
}

/** Exit 約定: orders を filled に更新 + position/trade/portfolio 反映 + "🔵/🔴 約定" 通知 */
export async function fillExitOrder(args: FillExitArgs): Promise<void> {
  const { orderId, positionId, model, symbol, fill, sellQty, ratio } = args;
  const isFullClose = ratio >= 0.999999;

  await db.transaction(async (tx) => {
    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.model, model)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${model}`);

    const position = (
      await tx.select().from(positions).where(eq(positions.id, positionId)).limit(1)
    )[0];
    if (!position) throw new Error(`Position not found: ${positionId}`);

    const pnlJpy = (fill.executedPrice - Number(position.avgEntryPrice)) * sellQty - fill.feeJpy;

    await tx
      .update(orders)
      .set({
        status: "filled",
        sizeJpy: (sellQty * fill.executedPrice).toFixed(4),
        quantity: sellQty.toFixed(10),
        price: fill.executedPrice.toFixed(4),
        fee: fill.feeJpy.toFixed(4),
        slippage: fill.slippageJpy.toFixed(4),
        completedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    await tx.insert(trades).values({
      positionId,
      orderId,
      coinId: position.coinId,
      model,
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
      // 部分決済: position の qty を削減し open のまま維持
      const remainingQty = Number(position.quantity) - sellQty;
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
        model,
        symbol,
        executedPrice: fill.executedPrice,
        pnlJpy,
        forced: args.forced,
        reason: args.reason,
        ratio,
        newCash,
      },
      isFullClose ? "fillExitOrder done (full)" : "fillExitOrder done (partial)",
    );

    const isProfit = pnlJpy >= 0;
    const partialLabel = isFullClose ? "" : ` ${Math.round(ratio * 100)}%`;
    await notify({
      level: args.forced ? "warning" : isProfit ? "success" : "info",
      title: `${isProfit ? "🔵" : "🔴"} 約定 (売${partialLabel}) ${symbol}${args.forced ? " 強制" : ""}`,
      body: args.reason ?? undefined,
      fields: {
        数量: sellQty.toFixed(8),
        価格: `¥${Math.round(fill.executedPrice).toLocaleString()}`,
        損益: `${isProfit ? "+" : ""}¥${Math.round(pnlJpy).toLocaleString()}`,
        手数料: `¥${fill.feeJpy.toFixed(0)}`,
        スリッページ: args.forced ? `¥${fill.slippageJpy.toFixed(0)}` : "0",
        残現金: `¥${Math.round(newCash).toLocaleString()}`,
      },
    });
  });
}

// =====================================================================
// 実マネー mode 用 lifecycle ハンドラ (将来 GMO webhook から呼ぶ)
// =====================================================================

/**
 * 注文期限切れ (実マネー時、TTL 超過で取引所がキャンセル)。
 * placeXxxOrder で記録した状態 → expired に遷移、通知。trade / portfolio 変更なし。
 */
export async function expireOrder(orderId: string): Promise<void> {
  const order = (await db.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.status !== "placed") {
    logger.warn({ orderId, status: order.status }, "expireOrder: not placed");
    return;
  }
  await db
    .update(orders)
    .set({ status: "expired", completedAt: new Date() })
    .where(eq(orders.id, orderId));
  const coin = (await db.select().from(coins).where(eq(coins.id, order.coinId)).limit(1))[0];
  await notify({
    level: "warning",
    title: `⏰ 期限切れ ${coin?.symbol ?? "?"} (${order.side})`,
    fields: {
      参考価格: `¥${Math.round(Number(order.price)).toLocaleString()}`,
      TTL: order.ttlHours ? `${order.ttlHours}h` : "—",
    },
  });
}

/** 注文拒否 (取引所側で reject、残高不足など) */
export async function rejectOrder(orderId: string, reason: string): Promise<void> {
  const order = (await db.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
  if (!order) throw new Error(`Order not found: ${orderId}`);
  await db
    .update(orders)
    .set({ status: "rejected", completedAt: new Date(), reason })
    .where(eq(orders.id, orderId));
  const coin = (await db.select().from(coins).where(eq(coins.id, order.coinId)).limit(1))[0];
  await notify({
    level: "warning",
    title: `🚫 拒否 ${coin?.symbol ?? "?"} (${order.side})`,
    body: reason,
  });
}

/** 注文キャンセル (手動 / システム) */
export async function cancelOrder(orderId: string, reason: string): Promise<void> {
  const order = (await db.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0];
  if (!order) throw new Error(`Order not found: ${orderId}`);
  await db
    .update(orders)
    .set({ status: "cancelled", completedAt: new Date(), reason })
    .where(eq(orders.id, orderId));
  const coin = (await db.select().from(coins).where(eq(coins.id, order.coinId)).limit(1))[0];
  await notify({
    level: "info",
    title: `❌ キャンセル ${coin?.symbol ?? "?"} (${order.side})`,
    body: reason,
  });
}
