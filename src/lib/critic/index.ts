import { generateJson } from "@/lib/clients/generate-json";
import { getPrompt } from "@/lib/prompts";
import {
  type AllocationProposal,
  type CriticOutput,
  CriticOutputSchema,
} from "@/lib/schemas/llm-outputs";
import type { SystemHealth } from "@/lib/schemas/system-health";

export interface CriticInput {
  proposal: AllocationProposal;
  analystSummariesBySymbol: Record<string, unknown>;
  decisionsBySymbol: Record<string, unknown>;
  currentPositions: Array<{ symbol: string; qty: number; avgPrice: number }>;
  /** symbol → プロジェクト正式名称マップ (LLM 文脈用) */
  symbolToName: Record<string, string>;
  cashJpy: number;
  riskParams: { perCoinMaxRatio: number; killSwitchDdRatio: number };
  /** §33: システム健全性スナップ。データ不全銘柄の弾き等を Critic LLM に委ねる */
  systemHealth: SystemHealth;
}

export interface CriticResult {
  output: CriticOutput;
  promptVersion: string | null;
  llmModel: string;
}

/**
 * Critic LLM: 配分案を承認/拒否/修正。
 * 失敗時は throw して finalize step を fail させる (ALL-or-NOTHING、サイクル全体中断)。
 */
export async function runCritic(input: CriticInput): Promise<CriticResult> {
  const resolved = await getPrompt("tier4/critic", {
    allocation_proposal: JSON.stringify(input.proposal, null, 2),
    analyst_summaries: JSON.stringify(input.analystSummariesBySymbol, null, 2),
    decisions: JSON.stringify(input.decisionsBySymbol, null, 2),
    current_positions: JSON.stringify(input.currentPositions, null, 2),
    symbol_to_name: JSON.stringify(input.symbolToName, null, 2),
    cash_jpy: input.cashJpy,
    risk_params: JSON.stringify(input.riskParams, null, 2),
    system_health: JSON.stringify(input.systemHealth, null, 2),
  });

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
    llmModel: resolved.config.model,
  };
}
