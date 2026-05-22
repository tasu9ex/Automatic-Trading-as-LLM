import { generateJson } from "@/lib/clients/generate-json";
import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import type { ExecutionPlan } from "@/lib/cycle/execution-plan";
import { getPrompt } from "@/lib/prompts";
import { type CriticOutput, CriticOutputSchema } from "@/lib/schemas/llm-outputs";
import type { SystemHealth } from "@/lib/schemas/system-health";

export interface CriticInput {
  /** Exit dry-run + Allocator + Clipper 適用済の実行計画 */
  plan: ExecutionPlan;
  analystSummariesBySymbol: Record<string, unknown>;
  decisionsBySymbol: Record<string, unknown>;
  /** symbol → プロジェクト正式名称マップ (LLM 文脈用) */
  symbolToName: Record<string, string>;
  /** Exit 前 cash (実値) */
  currentCashJpy: number;
  /** equity = cash + Σ positions の mtm。per-coin total cap の base */
  equityJpy: number;
  riskParams: {
    /** 段 1: per-cycle 新規 buy 上限比率 (cash base) */
    perCoinMaxRatio: number;
    /** 段 2: per-coin 総エクスポージャ上限比率 (equity base、1.0 = 制限なし) */
    perCoinTotalMaxRatio?: number;
    killSwitchDdRatio: number;
  };
  /** §33: システム健全性スナップ。データ不全銘柄の弾き等を Critic LLM に委ねる */
  systemHealth: SystemHealth;
  /** サイクル間隔 (分)。per-cycle 上限の解釈を頻度依存にするため LLM に渡す */
  cycleIntervalMinutes: number;
}

export interface CriticResult {
  output: CriticOutput;
  promptVersion: string | null;
  llmModel: string;
}

/**
 * Critic LLM: 実行計画 (Exit + Entry) を承認/拒否/修正。
 * 失敗時は throw して finalize step を fail させる (ALL-or-NOTHING、サイクル全体中断)。
 */
export async function runCritic(input: CriticInput): Promise<CriticResult> {
  const resolved = await getPrompt("tier4/critic", {
    execution_plan: JSON.stringify(
      {
        entries: input.plan.entries,
        exits: input.plan.exits,
        currentPositions: input.plan.currentPositions,
        plannedPositions: input.plan.plannedPositions,
        projectedCashJpy: input.plan.projectedCashJpy,
        clipperChanges: input.plan.clipperChanges,
      },
      null,
      2,
    ),
    analyst_summaries: JSON.stringify(input.analystSummariesBySymbol, null, 2),
    decisions: JSON.stringify(input.decisionsBySymbol, null, 2),
    symbol_to_name: JSON.stringify(input.symbolToName, null, 2),
    cash_jpy: input.currentCashJpy,
    equity_jpy: input.equityJpy,
    risk_params: JSON.stringify(input.riskParams, null, 2),
    system_health: JSON.stringify(input.systemHealth, null, 2),
    cycle_interval: formatCycleInterval(input.cycleIntervalMinutes),
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
