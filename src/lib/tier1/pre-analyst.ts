import { generateJson } from "@/lib/clients/generate-json";
import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import { getPrompt } from "@/lib/prompts";
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
  const resolved = await getPrompt("tier1/pre-analyst", {
    symbol: snapshot.symbol,
    name: snapshot.name,
    perplexity_summary: snapshot.perplexitySummary,
    grok_summary: snapshot.grokSummary,
    price_snapshot: buildPriceSnapshotText(snapshot),
    cycle_interval: formatCycleInterval(cycleIntervalMinutes),
  });

  const output = await generateJson<PreAnalystOutput>({
    modelId: resolved.config.model,
    system: resolved.compiled.system ?? "",
    prompt: resolved.compiled.user,
    schema: PreAnalystOutputSchema,
    temperature: resolved.config.temperature,
    maxOutputTokens: resolved.config.maxTokens,
    thinkingLevel: resolved.config.thinkingLevel,
    feature: "tier1.pre-analyst",
    metadata: { symbol: snapshot.symbol },
  });

  return {
    output,
    promptVersion:
      resolved.metadata.source === "langfuse" ? String(resolved.metadata.version) : null,
    llmModel: resolved.config.model,
  };
}
