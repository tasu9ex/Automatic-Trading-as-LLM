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
import { DEFAULT_STRATEGY_ID } from "@/lib/cycle/defaults";
import { isEmergencyStopError, recordEmergencyStop } from "@/lib/cycle/emergency-stop";
import { recordCycleFailure } from "@/lib/cycle/failure";
import { type FinalizeResult, finalize } from "@/lib/cycle/finalize";
import {
  preflight,
  tier0Snapshots,
  tier1PreAnalyst,
  tier2Analyst,
  tier3Decisions,
} from "@/lib/cycle/phases";
import { createLogger } from "@/lib/logging";
import { runWithSession } from "@/lib/telemetry";

const logger = createLogger("cycle.judgment");

export interface JudgmentCycleInput {
  strategyId?: string;
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
  const strategyId = input.strategyId ?? DEFAULT_STRATEGY_ID;
  const startedAt = Date.now();

  logger.info({ cycleId, strategyId }, "Cycle started");

  const pre = await preflight({ cycleId, strategyId });
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

  // periodHours / cycleIntervalMinutes は preflight が確定 (proceed=true なら必ず存在)
  const periodHours = pre.periodHours ?? 24;
  const cycleIntervalMinutes = pre.cycleIntervalMinutes ?? 1440;

  const runPhase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isEmergencyStopError(err)) {
        // BB-2: 緊急停止は recordCycleFailure 経路に乗せない (人手 stop は失敗ではない)。
        // 専用 event 記録 + cycle.completedAt 埋め + Discord 通知。consecutiveFailures は変更しない。
        await recordEmergencyStop({ cycleId, strategyId, phase: name });
        throw err;
      }
      await recordCycleFailure({ cycleId, strategyId, phase: name, err });
      throw err;
    }
  };

  try {
    await runPhase("tier0-snapshots", () =>
      tier0Snapshots(cycleId, periodHours, cycleIntervalMinutes),
    );
    await runPhase("tier1-pre-analyst", () => tier1PreAnalyst(cycleId, cycleIntervalMinutes));
    await runPhase("tier2-analyst", () => tier2Analyst(cycleId, strategyId, cycleIntervalMinutes));
    await runPhase("tier3-decisions", () =>
      tier3Decisions(cycleId, strategyId, cycleIntervalMinutes),
    );
    const result: FinalizeResult = await runPhase("finalize", () =>
      finalize({ cycleId, strategyId, startedAt, cycleIntervalMinutes }),
    );
    return result;
  } catch {
    // recordCycleFailure / recordEmergencyStop 内で通知 + state 更新済み。ここでは aborted を返すのみ
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
