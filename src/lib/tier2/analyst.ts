import { generateJson } from "@/lib/clients/generate-json";
import { getPrompt } from "@/lib/prompts";
import { type AnalystOutput, AnalystOutputSchema } from "@/lib/schemas/llm-outputs";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";
import type { PreAnalystResult } from "@/lib/tier1/pre-analyst";

export interface AnalystResult {
  output: AnalystOutput;
  promptVersion: string | null;
  model: string;
}

function formatBars(bars: Snapshot["ohlcv1m"], maxRows: number): string {
  if (bars.length === 0) return "(データなし)";
  const recent = bars.slice(-maxRows);
  return recent
    .map((bar) => {
      const d = new Date(Number(bar.openTime)).toISOString();
      return `${d}: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`;
    })
    .join("\n");
}

/**
 * Tier 2 Analyst: Opus で銘柄ごとの市場見解 (4 セクション)。
 */
export async function runAnalyst(
  snapshot: Snapshot,
  preAnalyst: PreAnalystResult,
): Promise<AnalystResult> {
  const microMarket = snapshot.micro
    ? JSON.stringify(
        {
          spread率パーセント: snapshot.micro.spreadPct,
          top5買い板厚み: snapshot.micro.bidDepth5,
          top5売り板厚み: snapshot.micro.askDepth5,
          板の偏り_買い寄り度: snapshot.micro.bidBias,
          直近100約定の買い比率: snapshot.micro.tradeBuyRatio,
          観測約定数: snapshot.micro.tradeCount,
        },
        null,
        2,
      )
    : "(取得失敗)";

  const resolved = await getPrompt("tier2/analyst", {
    symbol: snapshot.symbol,
    pre_analyst_summary: JSON.stringify(preAnalyst.output, null, 2),
    perplexity_summary: snapshot.perplexitySummary,
    grok_summary: snapshot.grokSummary,
    ohlcv_1h_brief: formatBars(snapshot.ohlcv1m, 60),
    ohlcv_1d_brief: formatBars(snapshot.ohlcv1d, 30),
    micro_market: microMarket,
  });

  const output = await generateJson<AnalystOutput>({
    modelId: resolved.config.model,
    system: resolved.compiled.system ?? "",
    prompt: resolved.compiled.user,
    schema: AnalystOutputSchema,
    temperature: resolved.config.temperature,
    maxOutputTokens: resolved.config.maxTokens,
    thinkingLevel: resolved.config.thinkingLevel,
    feature: "tier2.analyst",
    metadata: { symbol: snapshot.symbol },
  });

  return {
    output,
    promptVersion:
      resolved.metadata.source === "langfuse" ? String(resolved.metadata.version) : null,
    model: resolved.config.model,
  };
}
