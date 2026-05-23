import type { AllocationProposal } from "@/lib/schemas/llm-outputs";

export interface BuySignal {
  symbol: string;
  /**
   * Entry LLM が出した size_pct (1-100 整数 %)。
   * proposal[sym] = maxBudgetJpy × (sizePct / 100)
   * maxBudgetJpy は呼び出し側で「現金 × perCoinMaxRatio」を渡す (LLM に渡したのと同じ base)。
   */
  sizePct: number;
}

export interface AllocatorInput {
  buySignals: BuySignal[];
  /** Entry LLM に渡した base (= currentCash × perCoinMaxRatio)。size_pct の解釈基準。 */
  maxBudgetJpy: number;
}

/**
 * Entry LLM が出した size_pct を JPY 額に変換するだけのシンプルな mapper。
 *
 * 旧版は confidence 加重で銘柄横断配分していた (sum=1 で正規化) が、
 * 「サイズは LLM が直接 size_pct で表現する」設計に移行。
 *
 * cross-symbol の合計上限 (totalCap) や per-coin total cap は Risk Clipper
 * (`src/lib/risk/clipper.ts`) が独立に適用するので、ここは per-symbol mapping のみ。
 */
export function allocate(input: AllocatorInput): AllocationProposal {
  const proposal: AllocationProposal = {};
  if (input.buySignals.length === 0 || input.maxBudgetJpy <= 0) return proposal;

  for (const sig of input.buySignals) {
    const pct = Math.max(0, Math.min(100, sig.sizePct));
    const jpy = Math.floor(input.maxBudgetJpy * (pct / 100));
    if (jpy > 0) proposal[sig.symbol] = jpy;
  }
  return proposal;
}
