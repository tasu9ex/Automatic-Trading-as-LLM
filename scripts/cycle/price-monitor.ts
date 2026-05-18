/**
 * 価格監視ループを 1 回実行。
 * 本番では Supabase pg_cron が 1 分ごとにこれを叩く。
 *
 * Usage:
 *   pnpm cycle:price-monitor
 */

import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { runPriceMonitor } from "@/lib/price-monitor";
import { captureError, initSentry, shutdownSentry } from "@/lib/telemetry";

const logger = createLogger("cycle.price-monitor");

async function main() {
  initSentry();
  const started = Date.now();
  await runPriceMonitor();
  logger.info({ elapsedMs: Date.now() - started }, "Price monitor done");
  await shutdownSentry();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err }, "Price monitor failed");
  captureError(err, { tags: { script: "cycle.price-monitor" } });
  await notify({
    level: "error",
    title: "❌ Price monitor CRASHED",
    body: `\`\`\`${(err as Error)?.stack?.slice(0, 1500) ?? String(err)}\`\`\``,
  });
  await shutdownSentry();
  process.exit(1);
});
