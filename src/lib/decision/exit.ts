import { generateJson } from "@/lib/clients/generate-json";
import { getPrompt } from "@/lib/prompts";
import { type ExitDecisionOutput, ExitDecisionOutputSchema } from "@/lib/schemas/llm-outputs";
import type { AnalystResult } from "@/lib/tier2/analyst";

export interface PositionState {
  symbol: string;
  avgEntryPrice: number;
  quantity: number;
  /** 現在の保有評価額 (JPY) */
  marketValueJpy: number;
  /** 含み損益 (JPY) */
  unrealizedPnlJpy: number;
  /** 保有期間 (日) */
  holdingDays: number;
  /** Entry 時の判断理由 (Exit 入力として参照) */
  entryReason: string | null;
  /** 保有中の最大含み益・含み損 (JPY) */
  peakPnlJpy: number;
  troughPnlJpy: number;
  /** Entry 時の仮説 (参考のみ、anchor 禁止) */
  entryExpectation: {
    expectedHoldingDays: { min: number; max: number } | null;
    targetPriceJpy: number | null;
    exitCondition: string | null;
  };
}

export interface ExitDecisionResult {
  output: ExitDecisionOutput;
  promptVersion: string | null;
  model: string;
}

export async function runExitDecision(
  position: PositionState,
  analyst: AnalystResult,
): Promise<ExitDecisionResult> {
  const exp = position.entryExpectation;
  const entryExpectationDesc = JSON.stringify(
    {
      _参考のみ_anchor禁止: true,
      予想保有期間: exp.expectedHoldingDays
        ? `${exp.expectedHoldingDays.min}-${exp.expectedHoldingDays.max} 日 (現在 ${position.holdingDays.toFixed(1)} 日経過)`
        : "(なし)",
      緩い目標価格: exp.targetPriceJpy ? `¥${exp.targetPriceJpy.toLocaleString()}` : "(なし)",
      Exit条件仮説: exp.exitCondition ?? "(なし)",
    },
    null,
    2,
  );

  const resolved = await getPrompt("exit-decision", {
    symbol: position.symbol,
    position_state: JSON.stringify(
      {
        建値: position.avgEntryPrice,
        保有量: position.quantity,
        含み損益JPY: position.unrealizedPnlJpy,
        保有期間日数: position.holdingDays,
        Entry理由: position.entryReason ?? "(記録なし)",
        保有中最大含み益JPY: position.peakPnlJpy,
        保有中最大含み損JPY: position.troughPnlJpy,
      },
      null,
      2,
    ),
    entry_expectation: entryExpectationDesc,
    analyst_synthesis: JSON.stringify(analyst.output.synthesis, null, 2),
    analyst_full: JSON.stringify(analyst.output, null, 2),
  });

  const output = await generateJson<ExitDecisionOutput>({
    modelId: resolved.config.model,
    system: resolved.compiled.system ?? "",
    prompt: resolved.compiled.user,
    schema: ExitDecisionOutputSchema,
    temperature: resolved.config.temperature,
    maxOutputTokens: resolved.config.maxTokens,
    feature: "decision.exit",
    metadata: { symbol: position.symbol },
  });

  return {
    output,
    promptVersion:
      resolved.metadata.source === "langfuse" ? String(resolved.metadata.version) : null,
    model: resolved.config.model,
  };
}
