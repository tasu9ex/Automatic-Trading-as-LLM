import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import { formatJpy } from "@/lib/format/jpy";
import { runPromptedJson } from "@/lib/prompts";
import { type ExitDecisionOutput, ExitDecisionOutputSchema } from "@/lib/schemas/llm-outputs";
import type { AnalystResult } from "@/lib/tier2/analyst";

/**
 * Tier 3 Exit に渡すポジション情報。JPY 絶対値は意図的に含めない。
 *   - 含み損益 % = (現在価値 - 建値コスト) / 建値コスト × 100
 *   - 保有期間日数 = 経過日数 (float)
 */
export interface PositionState {
  symbol: string;
  name: string;
  unrealizedPnlPct: number;
  holdingDays: number;
}

export interface ExitDecisionResult {
  output: ExitDecisionOutput;
  promptVersion: string | null;
  llmModel: string;
}

export async function runExitDecision(
  position: PositionState,
  analyst: AnalystResult,
  cycleIntervalMinutes: number,
  lastPriceJpy: number,
): Promise<ExitDecisionResult> {
  return runPromptedJson<ExitDecisionOutput>({
    promptName: "tier3/exit",
    vars: {
      symbol: position.symbol,
      name: position.name,
      last_price_jpy: formatJpy(lastPriceJpy).replace(/^¥/, ""),
      position_state: JSON.stringify(
        {
          含み損益パーセント: `${position.unrealizedPnlPct.toFixed(2)}%`,
          保有期間日数: Number(position.holdingDays.toFixed(2)),
        },
        null,
        2,
      ),
      analyst_synthesis: JSON.stringify(analyst.output.synthesis, null, 2),
      analyst_full: JSON.stringify(analyst.output, null, 2),
      cycle_interval: formatCycleInterval(cycleIntervalMinutes),
    },
    schema: ExitDecisionOutputSchema,
    feature: "decision.exit",
    metadata: { symbol: position.symbol },
  });
}
