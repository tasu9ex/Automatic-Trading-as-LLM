import { runJudgmentCycle } from "@/lib/cycle/judgment";
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
 * 1 時間ごとに判定サイクルを実行。
 *
 * cron 設定: 毎時 0 分 (UTC)
 *
 * Inngest は失敗時に自動でリトライ (デフォルト 4 回、指数バックオフ)。
 * 我々のサイクル内部にも失敗時の連続失敗カウンタ + kill switch があるので、
 * 過剰リトライ防止のため retries: 1 に絞る。
 */
export const judgmentCron = inngest.createFunction(
  {
    id: "judgment-cron",
    name: "Judgment Cycle (hourly)",
    retries: 1,
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    initTelemetry();
    initSentry();

    try {
      return await step.run("run-cycle", async () => {
        try {
          return await runJudgmentCycle({});
        } catch (err) {
          logger.error({ err }, "Judgment cycle failed");
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
