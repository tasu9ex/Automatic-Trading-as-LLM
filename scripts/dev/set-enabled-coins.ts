import { db } from "@/db/client";
import { coins } from "@/db/schema";
import { inArray, notInArray } from "drizzle-orm";

const ENABLED = ["BTC", "ETH"];

async function main() {
  await db.update(coins).set({ enabled: false }).where(notInArray(coins.symbol, ENABLED));
  await db.update(coins).set({ enabled: true }).where(inArray(coins.symbol, ENABLED));

  const rows = await db.select({ symbol: coins.symbol, enabled: coins.enabled }).from(coins);
  for (const r of rows) {
    console.log(`${r.enabled ? "✓" : "✗"} ${r.symbol}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
