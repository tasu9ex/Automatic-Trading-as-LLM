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
  /** 全買い信号合計で使う上限 (0-1)。totalBudget = cash × この比率 */
  maxAllocationRatio: number;
  method: SizingMethod;
}

/**
 * Confidence Weighted / Equal Weight で銘柄ごとの理想配分を計算 (§24)。
 *
 * **責務は配分の計算のみ**。per-coin cap / per-coin min / portfolio cap などの
 * ハードガードは Risk Clipper (`src/lib/risk/clipper.ts`) が独立に適用する。
 * これにより:
 *   - Critic が見る "Allocator 提案" が weighted ideal の素直な値になる
 *   - cap 系定数が DB (system_state) 駆動で動的に変わっても Allocator の式は不変
 *   - 旧実装にあった二重 cap (Allocator + Clipper) を解消
 *
 * 戻り値: { symbol: jpy } の Record。空マップは「投資対象なし」を意味する。
 */
export function allocate(input: AllocatorInput): AllocationProposal {
  const proposal: AllocationProposal = {};
  if (input.buySignals.length === 0) return proposal;

  const totalBudget = input.availableCashJpy * input.maxAllocationRatio;

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
    if (ideal > 0) {
      proposal[sig.symbol] = Math.floor(ideal);
    }
  }
  return proposal;
}
