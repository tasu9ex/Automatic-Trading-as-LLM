/**
 * 価格監視ループを 1 回実行。
 * 本番では Supabase pg_cron が 1 分ごとにこれを叩く。
 *
 * Usage:
 *   pnpm cycle:price-monitor
 */

import { createLogger } from "@/lib/logging";
import { runPriceMonitor } from "@/lib/price-monitor";

const logger = createLogger("cycle.price-monitor");

async function main() {
  const started = Date.now();
  await runPriceMonitor();
  logger.info({ elapsedMs: Date.now() - started }, "Price monitor done");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "Price monitor failed");
  process.exit(1);
});
