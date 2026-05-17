/** 約定価格 + 手数料 + (任意で) スリッページ計算 */

export interface FillCalcInput {
  side: "buy" | "sell";
  /** マーケット価格 */
  marketPrice: number;
  /** 約定金額 (JPY) ─ buy: 投入額、sell: 約定額 */
  quoteAmountJpy: number;
  /** Taker 手数料率 (例 0.0005 = 0.05%) */
  takerFeeRate: number;
  /** スリッページ比率 (例 0.003 = 0.3%、逆指値タッチ時のみ true) */
  slippageRate?: number;
}

export interface FillResult {
  /** 約定価格 (スリッページ反映後) */
  executedPrice: number;
  /** 約定数量 */
  quantity: number;
  /** 手数料 (JPY) */
  feeJpy: number;
  /** スリッページコスト (JPY) */
  slippageJpy: number;
  /** Buy: 実支払額 / Sell: 実受領額 (JPY) */
  netCashJpy: number;
}

/**
 * 仮想約定価格・数量・手数料を計算。
 * Buy: 手数料は約定金額に加算(支払い側)
 * Sell: 手数料は約定金額から控除(受領側)
 * 逆指値タッチ時は slippageRate を渡してスリッページコストを反映。
 */
export function calculateFill(input: FillCalcInput): FillResult {
  const slip = input.slippageRate ?? 0;
  const executedPrice =
    input.side === "buy" ? input.marketPrice * (1 + slip) : input.marketPrice * (1 - slip);
  const quantity = input.quoteAmountJpy / executedPrice;
  const feeJpy = input.quoteAmountJpy * input.takerFeeRate;
  const slippageJpy = input.quoteAmountJpy * slip;
  const netCashJpy =
    input.side === "buy" ? input.quoteAmountJpy + feeJpy : input.quoteAmountJpy - feeJpy;
  return { executedPrice, quantity, feeJpy, slippageJpy, netCashJpy };
}
