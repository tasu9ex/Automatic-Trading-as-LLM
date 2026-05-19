/**
 * 判定パイプライン (CLI 用、phase 関数の sequential 連結)。
 *
 * Inngest 版は src/lib/inngest/functions.ts で step.run 経由で同じ phase を呼ぶ
 * (per-Tier 60s 予算 + step retry)。
 *
 * 流れ:
 *   1. preflight       — exchange / running 確認、period 計算
 *   2. tier0Snapshots  — 全コイン並列 fetchSnapshot
 *   3. tier1PreAnalyst — 全コイン Haiku
 *   4. tier2Analyst    — skip_flag=false のコイン Opus
 *   5. tier3Decisions  — Entry/Exit Sonnet
 *   6. finalize        — Exit 約定 → Critic → Risk Clipper → Entry 約定 → state 更新 → kill switch
 *
 * 各 phase は ALL-or-NOTHING (1 コインでも retry 後失敗で throw → サイクル全体 abort)
 */

import { randomUUID } from "node:crypto";
import type { SizingMethod } from "@/lib/allocator";
import {
  type FinalizeResult,
  finalize,
  preflight,
  recordCycleFailure,
  tier0Snapshots,
  tier1PreAnalyst,
  tier2Analyst,
  tier3Decisions,
} from "@/lib/cycle/phases";
import { createLogger } from "@/lib/logging";
import { runWithSession } from "@/lib/telemetry";

const logger = createLogger("cycle.judgment");

export interface JudgmentCycleInput {
  model?: string;
  method?: SizingMethod;
}

export interface JudgmentCycleResult {
  cycleId: string;
  skipped?: "exchange_closed" | "not_running" | "no_coins" | "aborted";
  elapsedMs: number;
  symbolsProcessed: number;
  symbolsFailed: number;
  buySignals: number;
  exitsTriggered: number;
  entriesExecuted: number;
  criticDecision?: string;
}

export async function runJudgmentCycle(
  input: JudgmentCycleInput = {},
): Promise<JudgmentCycleResult> {
  const cycleId = randomUUID();
  return runWithSession(cycleId, () => runJudgmentCycleInner(cycleId, input));
}

async function runJudgmentCycleInner(
  cycleId: string,
  input: JudgmentCycleInput,
): Promise<JudgmentCycleResult> {
  const model = input.model ?? "opus-confidence";
  const method = input.method ?? "confidence";
  const startedAt = Date.now();

  logger.info({ cycleId, model, method }, "Cycle started");

  const pre = await preflight({ cycleId, model, method });
  if (!pre.proceed) {
    return {
      cycleId,
      skipped: pre.skipped,
      elapsedMs: Date.now() - startedAt,
      symbolsProcessed: 0,
      symbolsFailed: 0,
      buySignals: 0,
      exitsTriggered: 0,
      entriesExecuted: 0,
    };
  }

  // periodHours は preflight が確定 (proceed=true なら必ず存在)
  const periodHours = pre.periodHours ?? 24;

  const runPhase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      await recordCycleFailure({ cycleId, model, phase: name, err });
      throw err;
    }
  };

  try {
    await runPhase("tier0-snapshots", () => tier0Snapshots(cycleId, periodHours));
    await runPhase("tier1-pre-analyst", () => tier1PreAnalyst(cycleId));
    await runPhase("tier2-analyst", () => tier2Analyst(cycleId));
    await runPhase("tier3-decisions", () => tier3Decisions(cycleId, model));
    const result: FinalizeResult = await runPhase("finalize", () =>
      finalize({ cycleId, model, method, startedAt }),
    );
    return result;
  } catch {
    // recordCycleFailure 内で通知 + state 更新済み。ここでは aborted を返すのみ
    return {
      cycleId,
      skipped: "aborted",
      elapsedMs: Date.now() - startedAt,
      symbolsProcessed: 0,
      symbolsFailed: 1,
      buySignals: 0,
      exitsTriggered: 0,
      entriesExecuted: 0,
    };
  }
}
