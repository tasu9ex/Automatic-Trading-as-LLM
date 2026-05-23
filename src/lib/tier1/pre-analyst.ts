import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import { runPromptedJson } from "@/lib/prompts";
import { type PreAnalystOutput, PreAnalystOutputSchema } from "@/lib/schemas/llm-outputs";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";
import { formatOhlcvBars } from "@/lib/tier0/format-ohlcv";

export interface PreAnalystResult {
  output: PreAnalystOutput;
  promptVersion: string | null;
  llmModel: string;
}

export function buildPriceSnapshotText(s: Snapshot): string {
  return formatOhlcvBars(s.ohlcv, {
    maxRows: 3,
    datePrecision: "date",
    intervalLabel: s.klineInterval,
    emptyText: "(価格データなし)",
  });
}

/**
 * Tier 1 Pre-Analyst: Haiku で銘柄スクリーニング。
 * skip_flag=true なら Tier 2 以降スキップ (保有/未保有問わず)。
 */
export async function runPreAnalyst(
  snapshot: Snapshot,
  cycleIntervalMinutes: number,
): Promise<PreAnalystResult> {
  return runPromptedJson<PreAnalystOutput>({
    promptName: "tier1/pre-analyst",
    vars: {
      symbol: snapshot.symbol,
      name: snapshot.name,
      perplexity_summary: snapshot.perplexitySummary,
      grok_summary: snapshot.grokSummary,
      price_snapshot: buildPriceSnapshotText(snapshot),
      cycle_interval: formatCycleInterval(cycleIntervalMinutes),
    },
    schema: PreAnalystOutputSchema,
    feature: "tier1.pre-analyst",
    metadata: { symbol: snapshot.symbol },
  });
}
