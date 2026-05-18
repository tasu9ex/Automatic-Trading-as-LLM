import { generateJson } from "@/lib/clients/generate-json";
import { getPrompt } from "@/lib/prompts";
import { type PreAnalystOutput, PreAnalystOutputSchema } from "@/lib/schemas/llm-outputs";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";

export interface PreAnalystResult {
  output: PreAnalystOutput;
  promptVersion: string | null;
  model: string;
}

function buildPriceSnapshotText(s: Snapshot): string {
  if (s.ohlcv1d.length === 0) return "(価格データなし)";
  const recent = s.ohlcv1d.slice(-3);
  return recent
    .map((bar) => {
      const d = new Date(bar.openTime).toISOString().slice(0, 10);
      return `${d}: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`;
    })
    .join("\n");
}

/**
 * Tier 1 Pre-Analyst: Haiku で銘柄スクリーニング。
 * skip_flag は MVP 初期は記録のみ、Tier 2 は常時実行される。
 */
export async function runPreAnalyst(snapshot: Snapshot): Promise<PreAnalystResult> {
  const resolved = await getPrompt("pre-analyst", {
    symbol: snapshot.symbol,
    perplexity_summary: snapshot.perplexitySummary,
    grok_summary: snapshot.grokSummary,
    price_snapshot: buildPriceSnapshotText(snapshot),
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
    model: resolved.config.model,
  };
}
