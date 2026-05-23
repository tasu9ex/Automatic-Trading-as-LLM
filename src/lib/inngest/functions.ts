/**
 * Inngest cron + per-Tier step.run 分割。
 *
 * Vercel function 60s 制限 + Anthropic per-strategyId ITPM レート対策のため、各 Tier を
 * 独立した step.run() に分けて実行 (各 step が独立した 60s 予算 + step retry)。
 *
 * CLI 側 (runJudgmentCycle) は同じ phase 関数を sequential に呼ぶラッパー。
 *
 * フロー:
 *   step "preflight"     — schedule due 判定 + exchange / running / coin 確認
 *   step "tier0"         — 全コイン snapshot
 *   step "tier1"         — Haiku pre-analyst
 *   step "tier2"         — Opus analyst (skip_flag respect)
 *   step "tier3"         — Sonnet entry/exit decision
 *   step "finalize"      — Exit 約定 → Critic → Risk → Entry → state 更新
 *   step "advance-sched" — next_scheduled_at 更新
 */

import { randomUUID } from "node:crypto";
import type { SizingMethod } from "@/lib/allocator";
import { notifyCycleCost } from "@/lib/cycle/cost-notify";
import { isEmergencyStopError, recordEmergencyStop } from "@/lib/cycle/emergency-stop";
import {
  finalize,
  preflight,
  recordCycleFailure,
  tier0Snapshots,
  tier1PreAnalyst,
  tier2Analyst,
  tier3Decisions,
} from "@/lib/cycle/phases";
import { createLogger } from "@/lib/logging";
import { advanceNextScheduledAt, getSystemStateRow, isScheduleDue } from "@/lib/system-control";
import { captureError, initSentry, runWithSession, shutdownSentry } from "@/lib/telemetry";
import { inngest } from "./client";

const logger = createLogger("inngest.functions");

const DEFAULT_STRATEGY_ID = "trial-5";
const DEFAULT_METHOD: SizingMethod = "confidence";

/**
 * 各 step を runWithSession でラップ。AsyncLocalStorage は step.run の serialize
 * 境界を越えないため、step ごとに seed する必要あり。
 */
function withSession<T>(cycleId: string, fn: () => Promise<T>): Promise<T> {
  return runWithSession(cycleId, fn);
}

export const judgmentCron = inngest.createFunction(
  {
    id: "judgment-cron",
    name: "Judgment Cycle Scheduler (hourly tick)",
    retries: 1,
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    initSentry();

    try {
      // 1. Schedule due 判定 + preflight (exchange/running/coin)
      const pre = await step.run("preflight", async () => {
        const state = await getSystemStateRow();
        const now = new Date();
        if (state?.state !== "running") {
          logger.debug({ state: state?.state }, "Skip: not running");
          return { proceed: false as const, reason: "not_running" };
        }
        if (!isScheduleDue(now, state.nextScheduledAt)) {
          logger.debug(
            { nextScheduledAt: state.nextScheduledAt?.toISOString() },
            "Skip: not due yet",
          );
          return { proceed: false as const, reason: "not_due" };
        }

        const cycleId = randomUUID();
        const startedAt = Date.now();
        const result = await preflight({
          cycleId,
          strategyId: DEFAULT_STRATEGY_ID,
          method: DEFAULT_METHOD,
        });
        if (!result.proceed) {
          return {
            proceed: false as const,
            reason: result.skipped ?? "preflight_failed",
          };
        }
        return {
          proceed: true as const,
          cycleId,
          startedAt,
          periodHours: result.periodHours ?? 24,
          cycleIntervalMinutes: result.cycleIntervalMinutes ?? 1440,
        };
      });

      if (!pre.proceed) {
        return { outcome: "skipped", reason: pre.reason };
      }

      const { cycleId, periodHours, cycleIntervalMinutes, startedAt } = pre;
      const strategyId = DEFAULT_STRATEGY_ID;
      const method = DEFAULT_METHOD;

      // 2-6. 各 Tier step.run (失敗時は recordCycleFailure → throw → Inngest 側で retry/abort)
      // finalize も同じパターンで包んで、Critic / Executor 失敗時に連続失敗カウンタ / Discord 通知が
      // CLI 経由 (judgment.ts) と同じになるようにする (§4)。
      const runStep = async (name: string, fn: () => Promise<void>) => {
        try {
          await step.run(name, () => withSession(cycleId, fn));
        } catch (err) {
          if (isEmergencyStopError(err)) {
            // BB-2: 緊急停止は recordCycleFailure 経路ではなく専用 event を記録
            await step.run(`${name}-record-emergency-stop`, () =>
              recordEmergencyStop({ cycleId, strategyId, phase: name }),
            );
            throw err;
          }
          await step.run(`${name}-record-failure`, () =>
            recordCycleFailure({ cycleId, strategyId, phase: name, err }),
          );
          throw err;
        }
      };

      await runStep("tier0-snapshots", () =>
        tier0Snapshots(cycleId, periodHours, cycleIntervalMinutes),
      );
      await runStep("tier1-pre-analyst", () => tier1PreAnalyst(cycleId, cycleIntervalMinutes));
      await runStep("tier2-analyst", () => tier2Analyst(cycleId, strategyId, cycleIntervalMinutes));
      await runStep("tier3-decisions", () =>
        tier3Decisions(cycleId, strategyId, cycleIntervalMinutes),
      );

      // finalize は値を返すので runStep 経由にせず個別 try/catch (§4)
      let result: Awaited<ReturnType<typeof finalize>>;
      try {
        result = await step.run("finalize", () =>
          withSession(cycleId, () =>
            finalize({ cycleId, strategyId, method, startedAt, cycleIntervalMinutes }),
          ),
        );
      } catch (err) {
        if (isEmergencyStopError(err)) {
          await step.run("finalize-record-emergency-stop", () =>
            recordEmergencyStop({ cycleId, strategyId, phase: "finalize" }),
          );
          throw err;
        }
        await step.run("finalize-record-failure", () =>
          recordCycleFailure({ cycleId, strategyId, phase: "finalize", err }),
        );
        throw err;
      }

      await step.run("advance-schedule", () => advanceNextScheduledAt(new Date(startedAt)));

      // 別 step で Langfuse cost 取得 + 累計加算 + Discord 通知 (15s ingestion 待ち含む)
      await step.run("cost-summary", () => notifyCycleCost(cycleId));

      return { outcome: "ran", result };
    } catch (err) {
      logger.error({ err }, "Cycle failed (top level)");
      captureError(err, { tags: { trigger: "inngest.judgment-cron" } });
      throw err;
    } finally {
      await shutdownSentry();
    }
  },
);

export const functions = [judgmentCron];
