/**
 * 判定パイプラインを CLI から 1 回実行する薄いラッパー。
 *
 * Usage:
 *   pnpm cycle:judgment
 *   pnpm cycle:judgment -- --model opus-confidence --method confidence
 *
 * 本体ロジックは src/lib/cycle/judgment.ts (Inngest からも呼ばれる)。
 */

import type { SizingMethod } from "@/lib/allocator";
import { runJudgmentCycle } from "@/lib/cycle/judgment";
import { createLogger } from "@/lib/logging";
import {
  captureError,
  fetchCycleCost,
  initSentry,
  initTelemetry,
  shutdownSentry,
  shutdownTelemetry,
} from "@/lib/telemetry";

const logger = createLogger("cycle.judgment.cli");

function parseArgs(argv: string[]): { model?: string; method?: SizingMethod } {
  const out: { model?: string; method?: SizingMethod } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") {
      const v = argv[++i];
      if (v) out.model = v;
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

  // Langfuse ingestion 待ち (eventual consistency)
  console.log("\n--- Langfuse cost 取得待ち (15s)...");
  await new Promise((r) => setTimeout(r, 15_000));

  const cost = await fetchCycleCost(result.cycleId);
  if (cost) {
    console.log(`\n=== Cycle ${result.cycleId} cost ===`);
    console.log(`Total: $${cost.totalCostUsd.toFixed(4)} (≈¥${cost.totalCostJpy.toFixed(1)})`);
    console.log("By model:");
    for (const [model, stat] of Object.entries(cost.observationsByModel)) {
      console.log(`  ${model}: ${stat.count} calls, $${stat.costUsd.toFixed(4)}`);
    }
  } else {
    console.log("(cost 取得不可)");
  }

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
