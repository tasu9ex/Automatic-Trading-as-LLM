import { formatCycleInterval } from "@/lib/cycle/cycle-interval";
import type { ExecutionPlan } from "@/lib/cycle/execution-plan";
import { runPromptedJson } from "@/lib/prompts";
import { type CriticOutput, CriticOutputSchema } from "@/lib/schemas/llm-outputs";
import type { SystemHealth } from "@/lib/schemas/system-health";

export interface CriticInput {
  /** Exit dry-run + Allocator + Clipper 適用済の実行計画 */
  plan: ExecutionPlan;
  /** symbol → Analyst 全フィールド (confidence 除く) */
  analystFullBySymbol: Record<string, unknown>;
  /** symbol → entry/exit 全フィールド (confidence 除く) */
  decisionsBySymbol: Record<string, unknown>;
  /** symbol → プロジェクト正式名称マップ */
  symbolToName: Record<string, string>;
  /** Exit 前 cash (実値) */
  currentCashJpy: number;
  /** equity = cash + Σ positions の mtm */
  equityJpy: number;
  /** §33: システム健全性スナップ */
  systemHealth: SystemHealth;
  /** サイクル間隔 (分) */
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
  return runPromptedJson<CriticOutput>({
    promptName: "tier4/critic",
    vars: {
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
      analyst_full_by_symbol: JSON.stringify(input.analystFullBySymbol, null, 2),
      decisions_by_symbol: JSON.stringify(input.decisionsBySymbol, null, 2),
      symbol_to_name: JSON.stringify(input.symbolToName, null, 2),
      cash_jpy: input.currentCashJpy,
      equity_jpy: input.equityJpy,
      system_health: JSON.stringify(input.systemHealth, null, 2),
      cycle_interval: formatCycleInterval(input.cycleIntervalMinutes),
    },
    schema: CriticOutputSchema,
    feature: "critic",
  });
}
