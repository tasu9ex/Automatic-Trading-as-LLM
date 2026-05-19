import { runScheduledCycleIfDue } from "@/lib/inngest/run-scheduled-cycle";
import { createLogger } from "@/lib/logging";
import {
  captureError,
  initSentry,
  initTelemetry,
  shutdownSentry,
  shutdownTelemetry,
} from "@/lib/telemetry";
import { inngest } from "./client";

const logger = createLogger("inngest.functions");

/**
 * 毎時 0 分に tick。実際の判定間隔は system_state.cycle_interval_hours と
 * next_scheduled_at で制御（1h / 6h / 24h）。
 */
export const judgmentCron = inngest.createFunction(
  {
    id: "judgment-cron",
    name: "Judgment Cycle Scheduler (hourly tick)",
    retries: 1,
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    initTelemetry();
    initSentry();

    try {
      return await step.run("scheduled-cycle", async () => {
        try {
          return await runScheduledCycleIfDue();
        } catch (err) {
          logger.error({ err }, "Scheduled cycle failed");
          captureError(err, { tags: { trigger: "inngest.judgment-cron" } });
          throw err;
        }
      });
    } finally {
      await shutdownTelemetry();
      await shutdownSentry();
    }
  },
);

export const functions = [judgmentCron];
