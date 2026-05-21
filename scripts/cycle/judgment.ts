/**
 * 判定パイプラインを CLI から 1 回実行する薄いラッパー。
 *
 * Usage:
 *   pnpm cycle:local:judgment
 *   pnpm cycle:local:judgment -- --strategyId opus-confidence --method confidence
 *
 * 本体ロジックは src/lib/cycle/judgment.ts (Inngest からも呼ばれる)。
 */

import type { SizingMethod } from "@/lib/allocator";
import { notifyCycleCost } from "@/lib/cycle/cost-notify";
import { runJudgmentCycle } from "@/lib/cycle/judgment";
import { createLogger } from "@/lib/logging";
import {
  captureError,
  initSentry,
  initTelemetry,
  shutdownSentry,
  shutdownTelemetry,
} from "@/lib/telemetry";

const logger = createLogger("cycle.judgment.cli");

function parseArgs(argv: string[]): { strategyId?: string; method?: SizingMethod } {
  const out: { strategyId?: string; method?: SizingMethod } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strategyId") {
      const v = argv[++i];
      if (v) out.strategyId = v;
    } else if (a === "--method") {
      const v = argv[++i];
      if (v === "equal" || v === "confidence") out.method = v;
    }
  }
  return out;
}

async function main() {
  // 順序重要: Telemetry を先に初期化しないと @sentry/node 内部の OTel が
  // グローバル TracerProvider を握ってしまい、AI SDK のスパンが Langfuse に届かない
  initTelemetry();
  initSentry();

  const args = parseArgs(process.argv.slice(2));
  const result = await runJudgmentCycle(args);

  await shutdownTelemetry();

  // 内部で Langfuse ingestion 待ち + 取得 + 累計加算 + Discord 通知
  console.log("\n--- Langfuse cost 取得 + Discord 通知...");
  await notifyCycleCost(result.cycleId);

  await shutdownSentry();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err }, "Cycle failed");
  captureError(err, { tags: { script: "cycle.judgment" } });
  await shutdownTelemetry();
  await shutdownSentry();
  process.exit(1);
});
