import { generateJson } from "@/lib/clients/generate-json";
import { createLogger } from "@/lib/logging";
import { getPrompt } from "@/lib/prompts";
import {
  type AllocationProposal,
  type CriticOutput,
  CriticOutputSchema,
} from "@/lib/schemas/llm-outputs";

const logger = createLogger("critic");

export interface CriticInput {
  proposal: AllocationProposal;
  analystSummariesBySymbol: Record<string, unknown>;
  decisionsBySymbol: Record<string, unknown>;
  currentPositions: Array<{ symbol: string; qty: number; avgPrice: number }>;
  cashJpy: number;
  riskParams: { perCoinMaxRatio: number; killSwitchDdRatio: number };
}

export interface CriticResult {
  output: CriticOutput;
  promptVersion: string | null;
  model: string;
}

/**
 * Critic LLM: 配分案を承認/拒否/修正。
 * フェイルオープン: API エラー時は approve として返す(配分案そのまま採用)。
 */
export async function runCritic(input: CriticInput): Promise<CriticResult> {
  const resolved = await getPrompt("tier4/critic", {
    allocation_proposal: JSON.stringify(input.proposal, null, 2),
    analyst_summaries: JSON.stringify(input.analystSummariesBySymbol, null, 2),
    decisions: JSON.stringify(input.decisionsBySymbol, null, 2),
    current_positions: JSON.stringify(input.currentPositions, null, 2),
    cash_jpy: input.cashJpy,
    risk_params: JSON.stringify(input.riskParams, null, 2),
  });

  try {
    const output = await generateJson<CriticOutput>({
      modelId: resolved.config.model,
      system: resolved.compiled.system ?? "",
      prompt: resolved.compiled.user,
      schema: CriticOutputSchema,
      temperature: resolved.config.temperature,
      maxOutputTokens: resolved.config.maxTokens,
      thinkingLevel: resolved.config.thinkingLevel,
      feature: "critic",
    });
    return {
      output,
      promptVersion:
        resolved.metadata.source === "langfuse" ? String(resolved.metadata.version) : null,
      model: resolved.config.model,
    };
  } catch (err) {
    logger.warn({ err }, "Critic failed, fail-open (approve)");
    return {
      output: {
        decision: "approve",
        adjustments: null,
        reasoning: "fail-open due to critic error",
      },
      promptVersion: null,
      model: resolved.config.model,
    };
  }
}
