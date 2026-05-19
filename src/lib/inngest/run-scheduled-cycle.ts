import { runJudgmentCycle } from "@/lib/cycle/judgment";
import { createLogger } from "@/lib/logging";
import { advanceNextScheduledAt, getSystemStateRow, isScheduleDue } from "@/lib/system-control";

const logger = createLogger("inngest.scheduled-cycle");

export type ScheduledCycleOutcome =
  | { outcome: "skipped"; reason: "not_running" | "not_due" }
  | { outcome: "ran"; result: Awaited<ReturnType<typeof runJudgmentCycle>> };

/**
 * Inngest の毎時 tick から呼ぶ。DB の next_scheduled_at に従い判定サイクルを実行。
 */
export async function runScheduledCycleIfDue(): Promise<ScheduledCycleOutcome> {
  const state = await getSystemStateRow();
  const now = new Date();

  if (state?.state !== "running") {
    logger.debug({ state: state?.state }, "Skip: not running");
    return { outcome: "skipped", reason: "not_running" };
  }

  if (!isScheduleDue(now, state.nextScheduledAt)) {
    logger.debug({ nextScheduledAt: state.nextScheduledAt?.toISOString() }, "Skip: not due yet");
    return { outcome: "skipped", reason: "not_due" };
  }

  const result = await runJudgmentCycle({});
  await advanceNextScheduledAt(now);
  logger.info(
    { cycleId: result.cycleId, skipped: result.skipped, next: "advanced" },
    "Scheduled cycle finished",
  );
  return { outcome: "ran", result };
}
