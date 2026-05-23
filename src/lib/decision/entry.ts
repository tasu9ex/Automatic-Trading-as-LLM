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
 * Entry Decision: Analyst 見解を元に Buy / No と size_pct を判定。
 *
 * Tier 3 はポートフォリオ金額を見ない方針。size_pct は「max を 100 とした時の何 %」
 * という抽象 % で、JPY 換算は Allocator + Clipper が行う。
 *
 * lastPriceJpy: 現在価格 (市場価格 = 公開事実、判断材料として渡す)。
 */
export async function runEntryDecision(
  symbol: string,
  name: string,
  analyst: AnalystResult,
  cycleIntervalMinutes: number,
  lastPriceJpy: number,
): Promise<EntryDecisionResult> {
  return runPromptedJson<EntryDecisionOutput>({
    promptName: "tier3/entry",
    vars: {
      symbol,
      name,
      analyst_synthesis: JSON.stringify(analyst.output.synthesis, null, 2),
      analyst_full: JSON.stringify(analyst.output, null, 2),
      last_price_jpy: formatJpy(lastPriceJpy).replace(/^¥/, ""),
      cycle_interval: formatCycleInterval(cycleIntervalMinutes),
    },
    schema: EntryDecisionOutputSchema,
    feature: "decision.entry",
    metadata: { symbol },
  });
}
