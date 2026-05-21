import { generateJson } from "@/lib/clients/generate-json";
import { getPrompt } from "@/lib/prompts";
import { type PreAnalystOutput, PreAnalystOutputSchema } from "@/lib/schemas/llm-outputs";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";

export interface PreAnalystResult {
  output: PreAnalystOutput;
  promptVersion: string | null;
  llmModel: string;
}

function buildPriceSnapshotText(s: Snapshot): string {
  // §32: long TF (旧 1d) があればそれを優先、なければ primary 末尾を使う
  const bars = s.ohlcvLong.length > 0 ? s.ohlcvLong : s.ohlcvPrimary;
  if (bars.length === 0) return "(価格データなし)";
  const recent = bars.slice(-3);
  const interval = s.ohlcvLong.length > 0 ? s.longInterval : s.primaryInterval;
  return recent
    .map((bar) => {
      const d = new Date(Number(bar.openTime)).toISOString().slice(0, 10);
      return `${d} [${interval}]: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`;
    })
    .join("\n");
}

/**
 * Tier 1 Pre-Analyst: Haiku で銘柄スクリーニング。
 * skip_flag=true なら Tier 2 以降スキップ (保有/未保有問わず)。
 */
export async function runPreAnalyst(snapshot: Snapshot): Promise<PreAnalystResult> {
  const resolved = await getPrompt("tier1/pre-analyst", {
    symbol: snapshot.symbol,
    name: snapshot.name,
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
    llmModel: resolved.config.model,
  };
}
