import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import { formatJpy } from "@/lib/format/jpy";
import { runPromptedJson } from "@/lib/prompts";
import { type EntryDecisionOutput, EntryDecisionOutputSchema } from "@/lib/schemas/llm-outputs";
import type { AnalystResult } from "@/lib/tier2/analyst";

export interface EntryDecisionResult {
  output: EntryDecisionOutput;
  promptVersion: string | null;
  llmModel: string;
}

/**
 * Entry Decision: Analyst 見解を元に Buy / No を判定。
 * 未保有銘柄に対して実行。
 *
 * maxBudgetJpy: この銘柄に対する上限予算 (= 現金 × perCoinMaxRatio)。
 * LLM はこの金額の何 % 使うかを `size_pct` (1-100) で表現する。
 */
export async function runEntryDecision(
  symbol: string,
  name: string,
  analyst: AnalystResult,
  cycleIntervalMinutes: number,
  maxBudgetJpy: number,
): Promise<EntryDecisionResult> {
  return runPromptedJson<EntryDecisionOutput>({
    promptName: "tier3/entry",
    vars: {
      symbol,
      name,
      analyst_synthesis: JSON.stringify(analyst.output.synthesis, null, 2),
      analyst_full: JSON.stringify(analyst.output, null, 2),
      max_budget_jpy: formatJpy(maxBudgetJpy).replace(/^¥/, ""),
      cycle_interval: formatCycleInterval(cycleIntervalMinutes),
    },
    schema: EntryDecisionOutputSchema,
    feature: "decision.entry",
    metadata: { symbol },
  });
}
