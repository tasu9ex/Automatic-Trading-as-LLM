/**
 * GMO Public API から銘柄リストを取り込んで coins テーブルに upsert。
 * 本体ロジックは src/lib/coins/sync.ts (seed.ts からも呼ばれる)。
 *
 * Usage:
 *   pnpm db:local:sync-coins
 */

import { syncCoinsFromGmo } from "@/lib/coins/sync";

async function main() {
  console.log("Fetching GMO symbols...");
  const result = await syncCoinsFromGmo();
  console.log(
    `Total: ${result.total}, Inserted: ${result.inserted}, Updated: ${result.updated}, Disabled: ${result.disabled}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
