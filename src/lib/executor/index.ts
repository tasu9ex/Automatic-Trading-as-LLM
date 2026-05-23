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
import { PositionStatusValue } from "@/lib/constants/enums";
import { formatJpy, formatJpySigned } from "@/lib/format/jpy";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { and, eq } from "drizzle-orm";
import { type FillResult, calculateFill } from "./fees";
import { isPaperMode } from "./mode";

const logger = createLogger("executor");

const STOP_LIMIT_TRIGGER_RATIO = 0.75; // -25%
const STOP_LIMIT_LIMIT_RATIO = 0.73; // -27%
const STOP_MARKET_ENTRY_RATIO = 0.65; // -35%
const STOP_MARKET_PEAK_RATIO = 0.5; // -50%

/**
 * 3 種類の SL pending_orders を作成。
 * Entry 新規 / Pyramid / 部分決済後 のいずれからも呼ぶ。
 * 呼び出し側は事前に既存 active を deactivate しておくこと。
 */
async function insertStopLossOrders(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  positionId: string,
  coinId: string,
  strategyId: string,
  avgPrice: number,
  peakPrice: number,
) {
  await tx.insert(pendingOrders).values({
    positionId,
    coinId,
    strategyId,
    kind: "stop_limit_primary",
    triggerPrice: (avgPrice * STOP_LIMIT_TRIGGER_RATIO).toFixed(4),
    limitPrice: (avgPrice * STOP_LIMIT_LIMIT_RATIO).toFixed(4),
    createdBy: "code",
  });
  await tx.insert(pendingOrders).values({
    positionId,
    coinId,
    strategyId,
    kind: "stop_market_entry",
    triggerPrice: (avgPrice * STOP_MARKET_ENTRY_RATIO).toFixed(4),
    createdBy: "code",
  });
  await tx.insert(pendingOrders).values({
    positionId,
    coinId,
    strategyId,
    kind: "stop_market_peak",
    triggerPrice: (peakPrice * STOP_MARKET_PEAK_RATIO).toFixed(4),
    createdBy: "code",
  });
}

function expiresAtFrom(now: Date, ttlHours: number | null | undefined): Date | null {
  if (!ttlHours || ttlHours <= 0) return null;
  return new Date(now.getTime() + ttlHours * 3_600_000);
}

// =====================================================================
// Entry (Buy) ライフサイクル
// =====================================================================

export interface ExecuteEntryInput {
  strategyId: string;
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
    // PP: paper mode の place+fill atomicity。placeEntryOrder で orders 行が status=placed で
    // 作られた後、fillEntryOrder が落ちると "placed" のまま orphan order が残る。
    // 真のトランザクション化は placeEntryOrder の構造改修が必要なので、ここでは
    // catch して order を canceled にロールバックする補償処理で同等のクリーンアップを担保。
    try {
      await fillEntryOrder({
        orderId,
        strategyId: input.strategyId,
        symbol: input.symbol,
        fill,
        entryReason: input.entryReason,
        expectedHoldingDays: input.expectedHoldingDays ?? null,
        targetPriceJpy: input.targetPriceJpy ?? null,
        exitCondition: input.exitCondition ?? null,
      });
    } catch (fillErr) {
      try {
        await db
          .update(orders)
          .set({ status: "cancelled", completedAt: new Date() })
          .where(eq(orders.id, orderId));
        logger.warn({ orderId, symbol: input.symbol }, "Paper fill failed — order canceled");
      } catch (cleanupErr) {
        logger.error({ orderId, cleanupErr }, "Paper fill cleanup failed (orphan placed order)");
      }
      throw fillErr;
    }
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

  if (!input.decisionId) {
    // 現状 buy は必ず LLM 由来 (auto-buy 機能なし)。null は呼び出し側のバグ可能性。
    logger.warn({ symbol: input.symbol }, "placeEntryOrder: decisionId is null");
  }

  const intendedQty = input.budgetJpy / Math.max(input.marketPrice, 1);
  const now = new Date();
  const expires = expiresAtFrom(now, input.ttlHours);

  const [order] = await db
    .insert(orders)
    .values({
      decisionId: input.decisionId,
      coinId: coin.id,
      strategyId: input.strategyId,
      side: "buy",
      status: "placed",
      sizeJpy: input.budgetJpy.toFixed(4),
      quantity: intendedQty.toFixed(10),
      price: input.marketPrice.toFixed(4),
      // orders.reason は発生原因タグのみ (LLM 全文は decisions.reasoning / positions.entry_reason 側)。
      // sell 側 (placeExitOrder) と非対称だった buy も同じタグ運用に統一。
      reason: "llm decision",
      ttlHours: input.ttlHours?.toFixed(2) ?? null,
      expiresAt: expires,
    })
    .returning();
  if (!order) throw new Error("order insert failed");

  await notify({
    level: "info",
    title: `📤 発注 ${input.symbol} (買)`,
    fields: {
      数量: intendedQty.toFixed(8),
      参考価格: formatJpy(input.marketPrice),
      想定金額: formatJpy(intendedQty * input.marketPrice),
      予算: formatJpy(input.budgetJpy),
      TTL: input.ttlHours ? `${input.ttlHours}h` : "無期限",
    },
  });

  return { orderId: order.id };
}

interface FillEntryArgs {
  orderId: string;
  strategyId: string;
  symbol: string;
  fill: FillResult;
  entryReason: string | null;
  expectedHoldingDays: { min: number; max: number } | null;
  targetPriceJpy: number | null;
  exitCondition: string | null;
}

/** Entry 約定: orders を filled に更新 + position/trade/portfolio 反映 + "🟢 約定" 通知 */
async function fillEntryOrder(args: FillEntryArgs): Promise<void> {
  const { orderId, strategyId, symbol, fill } = args;
  await db.transaction(async (tx) => {
    const coin = (await tx.select().from(coins).where(eq(coins.symbol, symbol)).limit(1))[0];
    if (!coin) throw new Error(`Coin not found: ${symbol}`);

    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${strategyId}`);

    // orders は intended のまま。executed 値は trades に。
    await tx
      .update(orders)
      .set({ status: "filled", completedAt: new Date() })
      .where(eq(orders.id, orderId));

    const existing = (
      await tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.strategyId, strategyId),
            eq(positions.coinId, coin.id),
            eq(positions.status, PositionStatusValue.OPEN),
          ),
        )
        .limit(1)
    )[0];

    let positionId: string;
    let newAvgPrice: number;
    // avgEntryPrice は **手数料込みの平均取得コスト** = (gross + fee) / qty。
    // これにより Exit 時の PnL = (sellPrice - avgEntry) × sellQty - sellFee が
    // buy 側手数料を含めた正確な実現損益となる。
    const buyCostPerUnit = fill.executedPrice + fill.feeJpy / Math.max(fill.quantity, 1e-12);
    if (existing) {
      // ピラミッディング: 加重平均で建値更新、Entry 仮説も最新で上書き
      const prevQty = Number(existing.quantity);
      const prevAvg = Number(existing.avgEntryPrice);
      const newQty = prevQty + fill.quantity;
      newAvgPrice = (prevAvg * prevQty + buyCostPerUnit * fill.quantity) / newQty;

      await tx
        .update(positions)
        .set({
          quantity: newQty.toFixed(10),
          avgEntryPrice: newAvgPrice.toFixed(4),
          peakPrice: Math.max(Number(existing.peakPrice), fill.executedPrice).toFixed(4),
          // §25: peak と対称に trough も更新 (新規 fill が既存最安値より低い場合のみ動く)
          troughPrice: Math.min(Number(existing.troughPrice), fill.executedPrice).toFixed(4),
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
      newAvgPrice = buyCostPerUnit;
      const [pos] = await tx
        .insert(positions)
        .values({
          strategyId,
          coinId: coin.id,
          status: "open",
          quantity: fill.quantity.toFixed(10),
          avgEntryPrice: buyCostPerUnit.toFixed(4),
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
      strategyId,
      side: "buy",
      quantity: fill.quantity.toFixed(10),
      price: fill.executedPrice.toFixed(4),
      fee: fill.feeJpy.toFixed(4),
      slippage: fill.slippageJpy.toFixed(4),
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

    await insertStopLossOrders(tx, positionId, coin.id, strategyId, newAvgPrice, currentPeak);

    const newCash = Number(portfolio.cashJpy) - fill.netCashJpy;
    await tx
      .update(portfolios)
      .set({ cashJpy: newCash.toFixed(4), updatedAt: new Date() })
      .where(eq(portfolios.id, portfolio.id));

    logger.info(
      {
        strategyId,
        symbol,
        quantity: fill.quantity,
        executedPrice: fill.executedPrice,
        feeJpy: fill.feeJpy,
        newAvgPrice,
        newCash,
      },
      "fillEntryOrder done",
    );

    const grossJpy = fill.quantity * fill.executedPrice;
    await notify({
      level: "success",
      title: `🟢 約定 ${symbol} (買)`,
      fields: {
        数量: fill.quantity.toFixed(8),
        価格: formatJpy(fill.executedPrice),
        約定金額: formatJpy(grossJpy),
        手数料: `¥${fill.feeJpy.toFixed(0)}`,
        支払総額: formatJpy(fill.netCashJpy),
        残現金: formatJpy(newCash),
      },
    });
  });
}

// =====================================================================
// Exit (Sell) ライフサイクル
// =====================================================================

export interface ExecuteExitInput {
  strategyId: string;
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
    // PP: paper mode の place+fill atomicity (Exit 側)。fill 失敗時に order を canceled に
    // ロールバックして orphan を残さない。
    try {
      await fillExitOrder({
        orderId: placed.orderId,
        positionId: placed.positionId,
        strategyId: input.strategyId,
        symbol: input.symbol,
        fill,
        sellQty,
        ratio,
        forced: input.forced,
        reason: input.reason,
      });
    } catch (fillErr) {
      try {
        await db
          .update(orders)
          .set({ status: "cancelled", completedAt: new Date() })
          .where(eq(orders.id, placed.orderId));
        logger.warn(
          { orderId: placed.orderId, symbol: input.symbol },
          "Paper exit fill failed — order canceled",
        );
      } catch (cleanupErr) {
        logger.error(
          { orderId: placed.orderId, cleanupErr },
          "Paper exit cleanup failed (orphan placed order)",
        );
      }
      throw fillErr;
    }
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
          eq(positions.strategyId, input.strategyId),
          eq(positions.coinId, coin.id),
          eq(positions.status, PositionStatusValue.OPEN),
        ),
      )
      .limit(1)
  )[0];
  if (!position) {
    logger.warn(
      { strategyId: input.strategyId, symbol: input.symbol },
      "placeExitOrder: no open position",
    );
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
      strategyId: input.strategyId,
      side: "sell",
      status: "placed",
      sizeJpy: (sellQty * input.marketPrice).toFixed(4),
      quantity: sellQty.toFixed(10),
      price: input.marketPrice.toFixed(4),
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
      title: `📤 発注 ${input.symbol} (売${isFull ? "" : ` ${Math.round(ratio * 100)}%`})`,
      body: input.reason ?? undefined,
      fields: {
        数量: sellQty.toFixed(8),
        参考価格: formatJpy(input.marketPrice),
        想定金額: formatJpy(sellQty * input.marketPrice),
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
  strategyId: string;
  symbol: string;
  fill: FillResult;
  sellQty: number;
  ratio: number;
  forced?: boolean;
  reason?: string;
}

/** Exit 約定: orders を filled に更新 + position/trade/portfolio 反映 + "🔵/🔴 約定" 通知 */
async function fillExitOrder(args: FillExitArgs): Promise<void> {
  const { orderId, positionId, strategyId, symbol, fill, sellQty, ratio } = args;
  const isFullClose = ratio >= 0.999999;

  await db.transaction(async (tx) => {
    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${strategyId}`);

    const position = (
      await tx.select().from(positions).where(eq(positions.id, positionId)).limit(1)
    )[0];
    if (!position) throw new Error(`Position not found: ${positionId}`);

    const pnlJpy = (fill.executedPrice - Number(position.avgEntryPrice)) * sellQty - fill.feeJpy;

    // orders は intended のまま。executed 値は trades に。
    await tx
      .update(orders)
      .set({ status: "filled", completedAt: new Date() })
      .where(eq(orders.id, orderId));

    await tx.insert(trades).values({
      positionId,
      orderId,
      coinId: position.coinId,
      strategyId,
      side: "sell",
      quantity: sellQty.toFixed(10),
      price: fill.executedPrice.toFixed(4),
      fee: fill.feeJpy.toFixed(4),
      slippage: fill.slippageJpy.toFixed(4),
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

      // §9: 部分決済後の SL rearm。avgPrice / peakPrice は不変だが、ピラミ時と挙動を
      // 揃えて再配置 (deactivate → re-insert)。将来 SL 式を変更したとき自動的に両側に効くため。
      await tx
        .update(pendingOrders)
        .set({ active: false, updatedAt: new Date() })
        .where(and(eq(pendingOrders.positionId, position.id), eq(pendingOrders.active, true)));
      await insertStopLossOrders(
        tx,
        position.id,
        position.coinId,
        strategyId,
        Number(position.avgEntryPrice),
        Number(position.peakPrice),
      );
    }

    const newCash = Number(portfolio.cashJpy) + fill.netCashJpy;
    await tx
      .update(portfolios)
      .set({ cashJpy: newCash.toFixed(4), updatedAt: new Date() })
      .where(eq(portfolios.id, portfolio.id));

    logger.info(
      {
        strategyId,
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
    const grossJpy = sellQty * fill.executedPrice;
    const sellFields: Record<string, string> = {
      数量: sellQty.toFixed(8),
      価格: formatJpy(fill.executedPrice),
      約定金額: formatJpy(grossJpy),
      手数料: `¥${fill.feeJpy.toFixed(0)}`,
      受領額: formatJpy(fill.netCashJpy),
      損益: formatJpySigned(pnlJpy),
      残現金: formatJpy(newCash),
    };
    if (args.forced) {
      sellFields.スリッページ = `¥${fill.slippageJpy.toFixed(0)}`;
    }
    await notify({
      level: args.forced ? "warning" : isProfit ? "success" : "warning",
      title: `${isProfit ? "🔵" : "🔴"} 約定 ${symbol} (売${partialLabel})${args.forced ? " 強制" : ""}`,
      body: args.reason ?? undefined,
      fields: sellFields,
    });
  });
}
