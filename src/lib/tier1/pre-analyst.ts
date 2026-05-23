import { generateJson } from "@/lib/clients/generate-json";
import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import { getPrompt } from "@/lib/prompts";
import { type PreAnalystOutput, PreAnalystOutputSchema } from "@/lib/schemas/llm-outputs";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";

export interface PreAnalystResult {
  output: PreAnalystOutput;
  promptVersion: string | null;
  llmModel: string;
}

/**
 * OHLCV を LLM 用テキストに整形。価格は **bitFlyer JPY 建て** であることを ¥ 接頭で明示。
 * 報道由来の USD 価格と混同してスケール誤読 ($12.4k 等) するのを防ぐため。
 */
export function buildPriceSnapshotText(s: Snapshot): string {
  if (s.ohlcv.length === 0) return "(価格データなし)";
  const recent = s.ohlcv.slice(-3);
  const fmt = (n: string | number) => `¥${Math.round(Number(n)).toLocaleString("en-US")}`;
  return recent
    .map((bar) => {
      const d = new Date(Number(bar.openTime)).toISOString().slice(0, 10);
      return `${d} [${s.klineInterval}]: O=${fmt(bar.open)} H=${fmt(bar.high)} L=${fmt(bar.low)} C=${fmt(bar.close)} V=${bar.volume}`;
    })
    .join("\n");
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
