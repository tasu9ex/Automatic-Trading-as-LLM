import { generateJson } from "@/lib/clients/generate-json";
import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import { getPrompt } from "@/lib/prompts";
import { type AnalystOutput, AnalystOutputSchema } from "@/lib/schemas/llm-outputs";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";
import type { PreAnalystResult } from "@/lib/tier1/pre-analyst";

export interface AnalystResult {
  output: AnalystOutput;
  promptVersion: string | null;
  llmModel: string;
}

/**
 * OHLCV を LLM 用テキストに整形。価格は **bitFlyer JPY 建て** であることを ¥ 接頭で明示。
 * 報道由来の USD 価格と混同してスケール誤読 ($12.4k 等) するのを防ぐため。
 */
export function formatBars(bars: Snapshot["ohlcv"], maxRows: number): string {
  if (bars.length === 0) return "(データなし)";
  const recent = bars.slice(-maxRows);
  const fmt = (n: string | number) => `¥${Math.round(Number(n)).toLocaleString("en-US")}`;
  return recent
    .map((bar) => {
      const d = new Date(Number(bar.openTime)).toISOString();
      return `${d}: O=${fmt(bar.open)} H=${fmt(bar.high)} L=${fmt(bar.low)} C=${fmt(bar.close)} V=${bar.volume}`;
    })
    .join("\n");
}

/**
 * Tier 2 Analyst: Opus で銘柄ごとの市場見解 (4 セクション)。
 */
export async function runAnalyst(
  snapshot: Snapshot,
  preAnalyst: PreAnalystResult,
  cycleIntervalMinutes: number,
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
    name: snapshot.name,
    pre_analyst_summary: JSON.stringify(preAnalyst.output, null, 2),
    perplexity_summary: snapshot.perplexitySummary,
    grok_summary: snapshot.grokSummary,
    // Kline: サイクル interval × TARGET_BARS (200) 本 (旧 primary/long の二段は廃止)
    kline_interval: snapshot.klineInterval,
    bars_count: snapshot.ohlcv.length,
    ohlcv_brief: formatBars(snapshot.ohlcv, 200),
    micro_market: microMarket,
    cycle_interval: formatCycleInterval(cycleIntervalMinutes),
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
    llmModel: resolved.config.model,
  };
}
