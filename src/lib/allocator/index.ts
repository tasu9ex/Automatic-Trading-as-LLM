import type { SizingMethod } from "@/lib/constants/enums";
import type { AllocationProposal } from "@/lib/schemas/llm-outputs";

export type { SizingMethod };

export interface BuySignal {
  symbol: string;
  confidence: number; // 0-1
}

export interface AllocatorInput {
  buySignals: BuySignal[];
  availableCashJpy: number;
  maxAllocationRatio: number; // 0-1, 全買い信号合計で使う上限
  perCoinMaxRatio: number; // 0-1, 1 銘柄あたり上限 (現金比)
  perCoinMinJpy: number; // 1 銘柄あたり下限 (これ未満はスキップ)
  method: SizingMethod;
}

/**
 * Confidence Weighted / Equal Weight でサイズ配分。
 * Risk Clipper は後段で別途実行 (per-coin / portfolio hard cap)。
 *
 * 戻り値: { symbol: jpy } の Record。下限割れた銘柄はマップに含めない。
 */
export function allocate(input: AllocatorInput): AllocationProposal {
  const proposal: AllocationProposal = {};
  if (input.buySignals.length === 0) return proposal;

  const totalBudget = input.availableCashJpy * input.maxAllocationRatio;
  const perCoinCap = input.availableCashJpy * input.perCoinMaxRatio;

  let weights: Record<string, number>;
  if (input.method === "equal") {
    const n = input.buySignals.length;
    weights = Object.fromEntries(input.buySignals.map((s) => [s.symbol, 1 / n]));
  } else {
    const sum = input.buySignals.reduce((acc, s) => acc + s.confidence, 0);
    if (sum <= 0) return proposal;
    weights = Object.fromEntries(input.buySignals.map((s) => [s.symbol, s.confidence / sum]));
  }

  for (const sig of input.buySignals) {
    const ideal = totalBudget * (weights[sig.symbol] ?? 0);
    const clipped = Math.min(ideal, perCoinCap);
    if (clipped >= input.perCoinMinJpy) {
      proposal[sig.symbol] = Math.floor(clipped);
    }
  }
  return proposal;
}
