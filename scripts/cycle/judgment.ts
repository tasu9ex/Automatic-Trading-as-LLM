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
  await runJudgmentCycle(args);

  await shutdownTelemetry();
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
